import express from 'express';
import bodyParser from 'body-parser';
import logger from 'winston';
import expressWinston from 'express-winston';
import 'winston-daily-rotate-file';
import chalk from 'chalk';
import { Configuration, loadConfiguration } from './models/Configuration.model.js';
import { Application } from './models/Application.model.js';
import axios, { AxiosResponse } from 'axios';
import http from 'node:http';
import https from 'node:https';
import { createClient, RedisClientType } from 'redis';
import {
    DEFAULT_RESPONSE_LIMIT,
    buildCacheKey,
    isAllowedContentType,
    parseByteSize,
    ProxyRequestError,
    resolvePublicAddresses,
    safeLookup,
    validateTargetUrl,
} from './security/network.js';

const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60;
const DEFAULT_RATE_LIMIT_MAX = 300;

/**
 * SemBeacon Linked Data Proxy
 */
export class App {
    config: Configuration;
    app: express.Application;
    client: RedisClientType;
    private readonly httpAgent = new http.Agent({ lookup: safeLookup });
    private readonly httpsAgent = new https.Agent({ lookup: safeLookup });

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
                    // Log the path only: the query string contains the API key and the target URI.
                    msg: (_, res) => {
                        const statusCode = res.statusCode;
                        const statusColor = statusCode >= 400 ? chalk.red : chalk.green;
                        const expressMsgFormat =
                            chalk.gray('From {{req.ip}} - {{req.method}} {{req.path}}') +
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
            // One reverse proxy (nginx) terminates TLS and forwards X-Forwarded-For.
            this.app.set('trust proxy', 1);
            this.app.all('/', (req: express.Request, res: express.Response) => {
                this.proxyRequest(req, res).catch((error) => {
                    logger.error('Unhandled proxy error', error);
                    if (!res.headersSent) {
                        res.status(500).send({ error: 'Internal server error!' });
                    }
                });
            });

            this.app.set('port', this.config.port);

            this.app.listen(this.app.get('port'), () => {
                logger.info('Proxy server listening on port :' + this.config.port);
            });
        });
    }

    async proxyRequest(req: express.Request, res: express.Response): Promise<void> {
        // Set CORS headers
        res.header('access-control-allow-origin', '*');
        res.header('access-control-allow-methods', 'GET, HEAD');
        res.header('access-control-allow-headers', 'Accept');
        res.header('access-control-expose-headers', 'x-final-url, x-cache-hit');

        if (req.method === 'OPTIONS') {
            // CORS Preflight
            res.send();
            return;
        }

        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.header('Allow', 'GET, HEAD');
            res.status(405).send({ error: 'Only GET and HEAD requests are supported!' });
            return;
        }

        const api = req.query.api as string;
        const app = this.getApplication(api);
        if (!app) {
            res.status(401).send({ error: 'API key not found!' });
            return;
        }

        let target: URL;
        try {
            target = validateTargetUrl(req.query.uri as string);
            await resolvePublicAddresses(target.hostname);
        } catch (error) {
            this.sendError(res, error);
            return;
        }

        // Only allow specific accept headers
        if (app.accept && app.accept.length > 0) {
            const acceptHeader = req.header('Accept');
            if (!acceptHeader) {
                res.status(415).send({ error: 'Accept header is required!' });
                return;
            }

            const acceptedTypes = acceptHeader.split(',').map((type) => type.split(';')[0].trim());
            const isValidAcceptHeader = acceptedTypes.some((type) => app.accept.includes(type));

            if (!isValidAcceptHeader) {
                res.status(415).send({ error: 'Invalid Accept header!' });
                return;
            }
        }

        if (!(await this.checkRateLimit(app, req.ip))) {
            res.header('Retry-After', String(app.rateLimit?.windowSeconds ?? DEFAULT_RATE_LIMIT_WINDOW_SECONDS));
            res.status(429).send({ error: 'Too many requests!' });
            return;
        }

        const accept = req.header('Accept') ?? '';
        const removeHeaders = (req.query.headers as string) === '0';

        // Check cache
        this.getCachedResponse(app, accept, target.href)
            .then((cachedResponse) => {
                if (cachedResponse) {
                    logger.debug(`Serving cached response for ${target.host} (${app.id})`);
                    res.status(cachedResponse.status);
                    Object.keys(cachedResponse.headers).forEach((header) => {
                        res.setHeader(header, cachedResponse.headers[header]);
                    });
                    // Set any cache related headers
                    res.setHeader('x-cache-hit', 'true');
                    res.send(cachedResponse.data);
                    return;
                }
                this.proxyRequestToTarget(app, req, res, target, accept, removeHeaders);
            })
            .catch((error) => {
                logger.error('Error getting cached response', error);
                res.status(500).send({ error: 'Internal server error!' });
            });
    }

    proxyRequestToTarget(
        app: Application,
        req: express.Request,
        res: express.Response,
        target: URL,
        accept: string,
        removeHeaders: boolean,
    ): void {
        logger.info(`Proxying request for app '${app.id}' to ${target.host}`);
        const limit = parseByteSize(app.limit, DEFAULT_RESPONSE_LIMIT);
        axios({
            url: target.href,
            method: req.method,
            withCredentials: false,
            headers: {
                Accept: req.header('Accept'),
            },
            timeout: app.timeout || 5000,
            maxRedirects: 3,
            maxContentLength: limit,
            maxBodyLength: 0,
            httpAgent: this.httpAgent,
            httpsAgent: this.httpsAgent,
            beforeRedirect: (options) => {
                // Reject redirects to unsupported schemes or URLs with credentials.
                validateTargetUrl(options.href);
            },
        })
            .then((response) => {
                if (!isAllowedContentType(response.headers['content-type'], app.accept)) {
                    logger.warn(`Upstream returned a non-accepted content type for app '${app.id}'`);
                    res.status(502).send({ error: 'Upstream returned an unsupported content type!' });
                    return;
                }
                const responseUrl =
                    response.request.responseUrl ??
                    response.request.responseURL ??
                    (response.request.res ? response.request.res.responseUrl : '');
                const finalURL = !responseUrl || target.href.startsWith(responseUrl) ? target.href : responseUrl;
                logger.debug(`[${response.status}]${removeHeaders ? '[NO HEADERS]' : ''} Proxied ${target.host}`);
                const responseHeaders = {
                    ...(removeHeaders ? {} : response.headers),
                    'x-final-url': finalURL,
                };
                if (!removeHeaders) {
                    // Never forward hop-by-hop, re-encoded or cookie headers.
                    [
                        'connection',
                        'vary',
                        'etag',
                        'date',
                        'transfer-encoding',
                        'content-encoding',
                        'content-length',
                        'allow',
                        'set-cookie',
                        'set-cookie2',
                        'access-control-allow-origin',
                        'access-control-expose-headers',
                        'access-control-allow-credentials',
                    ].forEach((header) => delete responseHeaders[header]);
                }
                // Set response headers and modify the axios response
                Object.keys(responseHeaders).forEach((header) => {
                    res.setHeader(header, responseHeaders[header]);
                    response.headers[header] = responseHeaders[header];
                });
                // Save response
                if (response.status >= 200 && response.status < 300 && !response.headers['set-cookie']) {
                    this.setCachedResponse(app, accept, target.href, response);
                }
                if (req.method === 'HEAD') {
                    res.status(response.status).end();
                } else {
                    res.status(response.status).send(response.data);
                }
            })
            .catch((error) => {
                if (error instanceof ProxyRequestError) {
                    this.sendError(res, error);
                    return;
                }
                if (error.code === 'ERR_FR_MAX_CONTENT_LENGTH_EXCEEDED') {
                    res.status(413).send({ error: 'Upstream response is too large!' });
                    return;
                }
                if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
                    res.status(504).send({ error: 'Upstream request timed out!' });
                    return;
                }
                logger.error(`Error proxying request for app '${app.id}'`, error.message);
                res.status(502).send({ error: 'Could not proxy the request!' });
            });
    }

    /**
     * Return a ProxyRequestError with its status, or a generic 500.
     * @param res Response
     * @param error Error to send
     */
    private sendError(res: express.Response, error: unknown): void {
        if (error instanceof ProxyRequestError) {
            res.status(error.status).send({ error: error.message });
            return;
        }
        logger.error('Unexpected proxy error', error);
        res.status(500).send({ error: 'Internal server error!' });
    }

    getApplication(key: string): Application {
        return this.config.applications.find((app) => app.key === key);
    }

    /**
     * Redis-backed rate limit shared by all cluster workers.
     * @param app Application that owns the key
     * @param ip Client IP
     */
    private async checkRateLimit(app: Application, ip: string | undefined): Promise<boolean> {
        const windowSeconds = Math.max(1, app.rateLimit?.windowSeconds ?? DEFAULT_RATE_LIMIT_WINDOW_SECONDS);
        const max = Math.max(1, app.rateLimit?.max ?? DEFAULT_RATE_LIMIT_MAX);
        const window = Math.floor(Date.now() / (windowSeconds * 1000));
        const key = `${app.id.toLowerCase()}:ratelimit:${ip ?? 'unknown'}:${window}`;
        try {
            const count = await this.client.incr(key);
            if (count === 1) {
                await this.client.expire(key, windowSeconds);
            }
            return count <= max;
        } catch (error) {
            // A cache outage must not take the proxy down.
            logger.error('Rate limit check failed, allowing request', error);
            return true;
        }
    }

    getCachedResponse(app: Application, accept: string, uri: string): Promise<CachedResponse> {
        return new Promise((resolve, reject) => {
            const cacheTimeout = app.cacheTimeout || -1;
            if (cacheTimeout === -1) {
                resolve(null);
                return;
            }

            const key = buildCacheKey(app.id, accept, uri);
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

    setCachedResponse(app: Application, accept: string, uri: string, response: AxiosResponse): Promise<void> {
        return new Promise((resolve, reject) => {
            const cacheTimeout = app.cacheTimeout || -1;
            if (cacheTimeout === -1) {
                resolve();
                return; // Do not store
            }

            const key = buildCacheKey(app.id, accept, uri);
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
