import path, { dirname } from 'path';
import { Application } from './Application.model.js';
import fs from 'fs';
import { fileURLToPath } from 'url';

export interface Configuration {
    applications: Application[];
    port: number;
    log: {
        level: string;
    };
}

/**
 *
 */
export function loadConfiguration(): Configuration {
    // Load configuration
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const configPath = path.resolve(__dirname, '../../../config.json');
    const configFile = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(configFile);
    return config;
}
