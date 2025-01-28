import express from 'express';
import bodyParser from 'body-parser';
import logger from 'winston';
import expressWinston from 'express-winston';
import 'winston-daily-rotate-file';
import chalk from 'chalk';
import { Configuration, loadConfiguration } from './models/Configuration.model.js';
import { Application } from './models/Application.model.js';
import axios, { AxiosResponse } from 'axios';
import { createClient, RedisClientType } from 'redis';
import crypto from 'crypto';

/**
 * SemBeacon Linked Data Proxy
 */
export class App {
    config: Configuration;
    app: express.Application;
    client: RedisClientType;

    constructor() {
        // Load configuration
        this.config = loadConfiguration();

        // Initialize logger
        logger.configure({
            level: this.config.log.level,
            transports: [
                new logger.transports.Console({
                    format: logger.format.combine(
                        logger.format.colorize({ all: true }),
                        logger.format.timestamp({
                            format: 'YYYY-MM-DD HH:mm:ss',
                        }),
                        logger.format.printf((i) => `<${process.pid}> [${i.timestamp}][${i.level}] ${i.message}`),
                    ),
                }),
                new logger.transports.DailyRotateFile({
                    level: 'debug',
                    dirname: 'logs',
                    auditFile: 'logs/audit.json',
                    filename: 'logs/%DATE%.log',
                    datePattern: 'YYYY-MM-DD-HH',
                    zippedArchive: true,
                    format: logger.format.combine(
                        logger.format.timestamp({
                            format: 'YYYY-MM-DD HH:mm:ss',
                        }),
                        logger.format.printf((i) => `<${process.pid}> [${i.timestamp}][${i.level}] ${i.message}`),
                    ),
                    maxSize: '20m',
                    maxFiles: '14d',
                }),
            ],
        });
    }

    start(): void {
        // Connect to redis
        this.client = createClient({
            url: `redis://${process.env.REDIS_USER}:${process.env.REDIS_PASSWORD}@${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`,
        });
        this.client.on('error', (err) => logger.error('Redis Client Error', err));
        logger.info('Connecting to Redis...');
        this.client.connect().then(() => {
            logger.info('Connected to Redis');

            this.app = express();
            this.app.use(
                expressWinston.logger({
                    transports: [
                        new logger.transports.Console({
                            format: logger.format.combine(
                                logger.format.colorize({ all: true }),
                                logger.format.timestamp({
                                    format: 'YYYY-MM-DD HH:mm:ss',
                                }),
                                logger.format.printf((i) => `<${process.pid}> [${i.timestamp}] ${i.message}`),
                            ),
                        }),
                        new logger.transports.DailyRotateFile({
                            level: 'debug',
                            dirname: 'logs',
                            auditFile: 'logs/audit.json',
                            filename: 'logs/requests-%DATE%.log',
                            datePattern: 'YYYY-MM-DD-HH',
                            zippedArchive: true,
                            format: logger.format.combine(
                                logger.format.timestamp({
                                    format: 'YYYY-MM-DD HH:mm:ss',
                                }),
                                logger.format.printf(
                                    (i) => `<${process.pid}> [${i.timestamp}][${i.level}] ${i.message}`,
                                ),
                            ),
                            maxSize: '20m',
                            maxFiles: '14d',
                        }),
                    ],
                    level: 'info',
                    msg: (_, res) => {
                        const statusCode = res.statusCode;
                        const statusColor = statusCode >= 400 ? chalk.red : chalk.green;
                        const expressMsgFormat =
                            chalk.gray('From {{req.ip}} - {{req.method}} {{req.url}}') +
                            ' ' +
                            statusColor('{{res.statusCode}}') +
                            chalk.gray(' {{res.responseTime}}ms');
                        return expressMsgFormat;
                    },
                    ignoreRoute: function () {
                        return false;
                    },
                }),
            );
            this.app.use(bodyParser.json());
            this.app.disable('etag');
            this.app.all('/', this.proxyRequest.bind(this));

            this.app.set('port', this.config.port);

            this.app.listen(this.app.get('port'), () => {
                logger.info('Proxy server listening on port :' + this.config.port);
            });
        });
    }

    proxyRequest(req: express.Request, res: express.Response): void {
        // Set CORS headers
        res.header('access-control-allow-private-network', 'true');
        res.header('access-control-allow-origin', '*');
        res.header('access-control-allow-methods', 'GET, PUT, PATCH, POST, DELETE');
        res.header('access-control-allow-headers', req.header('access-control-request-headers'));
        res.header('access-control-expose-headers', 'x-final-url');

        if (req.method === 'OPTIONS') {
            // CORS Preflight
            res.send();
            return;
        } else {
            const api = req.query.api as string;
            const app = this.getApplication(api);
            if (!app) {
                res.status(500).send({ error: 'API key not found!' });
                return;
            }

            const removeHeaders = (req.query.headers as string) === '0';

            const targetURL = req.query.uri as string;
            if (!targetURL) {
                res.status(500).send({ error: 'Please provide an uri= GET paremeter!' });
                return;
            }

            // Only allow specific accept headers
            if (app.accept && app.accept.length > 0) {
                const acceptHeader = req.header('Accept');
                if (!acceptHeader) {
                    res.status(500).send({ error: 'Accept header is required!' });
                    return;
                }

                const acceptedTypes = acceptHeader.split(',').map((type) => type.split(';')[0].trim());
                const isValidAcceptHeader = acceptedTypes.some((type) => app.accept.includes(type));

                if (!isValidAcceptHeader) {
                    res.status(500).send({ error: 'Invalid Accept header!' });
                    return;
                }
            }

            // Check cache
            this.getCachedResponse(app, targetURL)
                .then((cachedResponse) => {
                    if (cachedResponse) {
                        logger.debug('Serving cached response for ' + targetURL);
                        res.status(cachedResponse.status);
                        Object.keys(cachedResponse.headers).forEach((header) => {
                            res.setHeader(header, cachedResponse.headers[header]);
                        });
                        // Set any cache related headers
                        res.setHeader('x-cache-hit', 'true');
                        res.send(cachedResponse.data);
                        return;
                    }
                    this.proxyRequestToTarget(app, req, res, targetURL, removeHeaders);
                })
                .catch((error) => {
                    logger.error('Error getting cached response', error);
                    res.status(500).send({ error: error.message });
                });
        }
    }

    proxyRequestToTarget(
        app: Application,
        req: express.Request,
        res: express.Response,
        targetURL: string,
        removeHeaders: boolean,
    ): void {
        logger.info('Proxying request to: ' + targetURL + ' from API: ' + app.id);
        axios(targetURL, {
            method: req.method,
            withCredentials: false,
            headers: {
                Accept: req.header('Accept'),
            },
            timeout: app.timeout || 5000,
        })
            .then((response) => {
                const responseUrl =
                    response.request.responseUrl ??
                    response.request.responseURL ??
                    (response.request.res ? response.request.res.responseUrl : '');
                const finalURL = targetURL.startsWith(responseUrl) ? targetURL : responseUrl;
                logger.debug(`[${response.status}]${removeHeaders ? '[NO HEADERS]' : ''} Proxying result ${finalURL}`);
                const responseHeaders = {
                    ...(removeHeaders ? {} : response.headers),
                    'x-final-url': finalURL,
                };
                if (!removeHeaders) {
                    delete responseHeaders['connection'];
                    delete responseHeaders['vary'];
                    delete responseHeaders['etag'];
                    delete responseHeaders['date'];
                    delete responseHeaders['transfer-encoding'];
                    delete responseHeaders['allow'];
                    delete responseHeaders['access-control-allow-origin'];
                    delete responseHeaders['access-control-expose-headers'];
                    delete responseHeaders['access-control-allow-credentials'];
                }
                // Set response headers
                Object.keys(responseHeaders).forEach((header) => {
                    res.setHeader(header, responseHeaders[header]);
                });
                // Save response
                this.setCachedResponse(app, targetURL, response);
                res.status(response.status).send(response.data);
            })
            .catch((error) => {
                logger.error('Error proxying request to: ' + targetURL + ' from API: ' + app.id, error);
                res.status(500).send({ error: error.message });
            });
    }

    getApplication(key: string): Application {
        return this.config.applications.find((app) => app.key === key);
    }

    getCachedResponse(app: Application, uri: string): Promise<CachedResponse> {
        return new Promise((resolve, reject) => {
            const cacheTimeout = app.cacheTimeout || -1;
            if (cacheTimeout === -1) {
                resolve(null);
                return;
            }

            const hashedUri = crypto.createHash('md5').update(uri).digest('hex');
            const key = `${app.id.toLowerCase()}:cache:${hashedUri}`;
            this.client
                .get(key)
                .then((result) => {
                    if (!result) {
                        resolve(null);
                        return;
                    }
                    // Deserialize response
                    const response: CachedResponse = JSON.parse(result);
                    resolve(response);
                })
                .catch(reject);
        });
    }

    setCachedResponse(app: Application, uri: string, response: AxiosResponse): Promise<void> {
        return new Promise((resolve, reject) => {
            const cacheTimeout = app.cacheTimeout || -1;
            if (cacheTimeout === -1) {
                resolve();
                return; // Do not store
            }

            const hashedUri = crypto.createHash('md5').update(uri).digest('hex');
            const key = `${app.id.toLowerCase()}:cache:${hashedUri}`;
            // Serialize response
            const serializedResponse = JSON.stringify({
                data: response.data,
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
            });
            this.client
                .setEx(key, cacheTimeout, serializedResponse)
                .then(() => {
                    resolve();
                })
                .catch(reject);
        });
    }
}

interface CachedResponse {
    data: any;
    status: number;
    statusText: string;
    headers: any;
}
