/*
 * inspectionClient.ts
 * Copyright (c) 2026
 * Licensed under the MIT license.
 *
 * HTTP client for communicating with the Python inspection server.
 */

import * as http from 'http';
import * as https from 'https';
import { InspectionRequest, InspectionResponse, ResourceLimits } from './types';

/**
 * Options for the inspection client.
 */
export interface InspectionClientOptions {
    /** Host address of the inspection server */
    host: string;
    /** Port of the inspection server */
    port: number;
    /** Use HTTPS instead of HTTP */
    secure?: boolean;
    /** Connection timeout in milliseconds */
    connectionTimeoutMs?: number;
}

/**
 * HTTP client for the Python inspection server.
 */
export class InspectionClient {
    private readonly _host: string;
    private readonly _port: number;
    private readonly _secure: boolean;
    private readonly _connectionTimeoutMs: number;
    private _isServerAvailable: boolean = false;
    private _lastHealthCheck: number = 0;
    private _healthCheckIntervalMs: number = 30000;

    constructor(options: InspectionClientOptions) {
        this._host = options.host;
        this._port = options.port;
        this._secure = options.secure ?? false;
        this._connectionTimeoutMs = options.connectionTimeoutMs ?? 5000;
    }

    /**
     * Gets the base URL for the inspection server.
     */
    get baseUrl(): string {
        const protocol = this._secure ? 'https' : 'http';
        return `${protocol}://${this._host}:${this._port}`;
    }

    /**
     * Checks if the inspection server is available.
     */
    get isAvailable(): boolean {
        return this._isServerAvailable;
    }

    /**
     * Performs an HTTP request.
     */
    private _request<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
        return new Promise((resolve, reject) => {
            const options: http.RequestOptions = {
                hostname: this._host,
                port: this._port,
                path,
                method,
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
                timeout: timeoutMs ?? this._connectionTimeoutMs,
            };

            const client = this._secure ? https : http;
            const req = client.request(options, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            const parsed = JSON.parse(data) as T;
                            resolve(parsed);
                        } catch (e) {
                            reject(new Error(`Failed to parse response: ${e}`));
                        }
                    } else {
                        reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                    }
                });
            });

            req.on('error', (error) => {
                reject(error);
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error(`Request timed out after ${timeoutMs ?? this._connectionTimeoutMs}ms`));
            });

            if (body) {
                req.write(JSON.stringify(body));
            }

            req.end();
        });
    }

    /**
     * Checks health of the inspection server.
     */
    async checkHealth(): Promise<boolean> {
        try {
            const response = await this._request<{ status: string }>('GET', '/health', undefined, 2000);
            this._isServerAvailable = response.status === 'ok';
            this._lastHealthCheck = Date.now();
            return this._isServerAvailable;
        } catch {
            this._isServerAvailable = false;
            this._lastHealthCheck = Date.now();
            return false;
        }
    }

    /**
     * Checks if a health check is needed.
     */
    private _needsHealthCheck(): boolean {
        return Date.now() - this._lastHealthCheck > this._healthCheckIntervalMs;
    }

    /**
     * Ensures the server is available, checking health if needed.
     */
    async ensureAvailable(): Promise<boolean> {
        if (this._needsHealthCheck()) {
            return this.checkHealth();
        }
        return this._isServerAvailable;
    }

    /**
     * Sends an inspection request to the server.
     */
    async inspect(request: InspectionRequest): Promise<InspectionResponse> {
        // Check server availability
        const available = await this.ensureAvailable();
        if (!available) {
            return {
                inspectionId: request.inspectionId,
                success: false,
                error: 'Inspection server is not available',
            };
        }

        try {
            // Use the request timeout plus some overhead
            const totalTimeout = request.timeoutMs + 1000;
            const response = await this._request<InspectionResponse>('POST', '/inspect', request, totalTimeout);
            return response;
        } catch (error) {
            return {
                inspectionId: request.inspectionId,
                success: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    /**
     * Registers an inspection script with the server.
     */
    async registerScript(typeName: string, scriptPath: string): Promise<boolean> {
        try {
            const response = await this._request<{ success: boolean }>('POST', '/register', { typeName, scriptPath });
            return response.success;
        } catch {
            return false;
        }
    }

    /**
     * Gets the list of registered type inspections.
     */
    async getRegisteredTypes(): Promise<string[]> {
        try {
            const response = await this._request<{ types: string[] }>('GET', '/types');
            return response.types;
        } catch {
            return [];
        }
    }

    /**
     * Shuts down the inspection server.
     */
    async shutdown(): Promise<void> {
        try {
            await this._request<void>('POST', '/shutdown');
        } catch {
            // Server might not respond to shutdown, that's OK
        }
        this._isServerAvailable = false;
    }
}

/**
 * Creates an inspection request.
 */
export function createInspectionRequest(
    inspectionId: string,
    typeName: string,
    payload: string,
    serialization: string,
    timeoutMs: number,
    resourceLimits?: ResourceLimits,
): InspectionRequest {
    return {
        inspectionId,
        type: typeName,
        serialization,
        payload,
        timeoutMs,
        resourceLimits,
    };
}
