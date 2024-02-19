import * as express from 'express';
import * as bodyParser from 'body-parser';
import * as logger from 'winston';
import * as expressWinston from 'express-winston';
import 'winston-daily-rotate-file';
import * as chalk from 'chalk';
import { Configuration } from './models/Configuration';
import * as path from 'path';
import axios from 'axios';
import { Application } from './models/Application';

/**
 * Based on: {@link https://github.com/ccoenraets/cors-proxy}
 */
export class App {
    config: Configuration;
    app: express.Application;
    logger: logger.Logger;

    constructor() {
        // Load configuration
        this.config = require(path.resolve('./config.json'));

        // Initialize logger
        this.logger = logger.createLogger({
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
                    maxFiles: '14d'
                })
            ],
        });
    }

    start(): void {
        this.app = express();
        this.app.use(
            expressWinston.logger({
                transports: [
                    new logger.transports.Console(),
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
                            logger.format.printf((i) => `<${process.pid}> [${i.timestamp}][${i.level}] ${i.message}`),
                        ),
                        maxSize: '20m',
                        maxFiles: '14d'
                    })
                ],
                level: 'info',
                format: logger.format.combine(
                    logger.format.colorize({ all: true }),
                    logger.format.timestamp({
                        format: 'YYYY-MM-DD HH:mm:ss',
                    }),
                    logger.format.printf((i) => `<${process.pid}> [${i.timestamp}] ${i.message}`),
                ),
                msg: () => {
                    const expressMsgFormat =
                        chalk.gray('From {{req.ip}} - {{req.method}} {{req.url}}') +
                        ' {{res.statusCode}} ' +
                        chalk.gray('{{res.responseTime}}ms');
                    return expressMsgFormat;
                },
                ignoreRoute: function (req, res) {
                    return false;
                },
            }),
        );
        this.app.use(bodyParser.json());

        this.app.all('/', (req: express.Request, res: express.Response, next: express.NextFunction) => {
            // Set CORS headers: allow all origins, methods, and headers: you may want to lock this down in a production environment
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Methods', 'GET, PUT, PATCH, POST, DELETE');
            res.header('Access-Control-Allow-Headers', req.header('access-control-request-headers'));

            if (req.method === 'OPTIONS') {
                // CORS Preflight
                res.send();
            } else {
                const api = req.query.api as string;
                const app = this.getApplication(api);
                if (!app) {
                    res.status(500).send({ error: 'API key not found!' });
                    return;
                }

                const targetURL = req.query.uri as string;
                if (!targetURL) {
                    res.status(500).send({ error: 'Please provide an uri= GET paremeter!' });
                    return;
                }
                this.logger.info('Proxying request to: ' + targetURL + ' from API: ' + api);
                this.logger.debug('Request headers: ' + JSON.stringify(req.headers));
                axios(targetURL,
                    {
                        method: req.method,
                        withCredentials: false,
                        headers: {
                            ...req.headers,
                            'Host': undefined,
                        },
                        timeout: app.timeout || 5000,
                    }
                ).then((response) => {
                    res.status(response.status)
                        .header(response.headers)
                        .send(response.data);
                }).catch((error) => {
                    res.status(500).send({ error: error.message });
                });
            }
        });

        this.app.set('port', this.config.port);

        this.app.listen(this.app.get('port'), () => {
            this.logger.info('Proxy server listening on port :' + this.config.port);
        });
    }

    getApplication(key: string): Application {
        return this.config.applications.find((app) => app.key === key);
    }
}
