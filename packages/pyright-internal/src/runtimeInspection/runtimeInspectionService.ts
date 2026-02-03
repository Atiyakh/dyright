/*
 * runtimeInspectionService.ts
 * Copyright (c) 2026
 * Licensed under the MIT license.
 *
 * Main service orchestrating runtime inspection for hover events.
 * Coordinates between config, kernel client, and inspection server.
 */

import * as crypto from 'crypto';
import { ConfigLoader } from './configLoader';
import { InspectionClient, createInspectionRequest } from './inspectionClient';
import { KernelClient, KernelConnectionState } from './kernelClient';
import { InspectionFailureReason, LspContextConfig, RuntimeInspectionResult, TypeInspectionConfig } from './types';

/**
 * Options for the runtime inspection service.
 */
export interface RuntimeInspectionServiceOptions {
    /** Workspace root directory */
    workspaceRoot: string;
    /** Enable debug logging */
    debug?: boolean;
}

/**
 * Main service for runtime inspection.
 *
 * This service:
 * 1. Loads and watches configuration
 * 2. Manages kernel connection
 * 3. Coordinates inspection flow
 * 4. Produces hover-ready results
 */
export class RuntimeInspectionService {
    private readonly _configLoader: ConfigLoader;
    private readonly _kernelClient: KernelClient;
    private _inspectionClient: InspectionClient | undefined;
    private readonly _debug: boolean;
    private _isInitialized: boolean = false;

    constructor(options: RuntimeInspectionServiceOptions) {
        this._configLoader = new ConfigLoader(options.workspaceRoot);
        this._kernelClient = new KernelClient();
        this._debug = options.debug ?? false;
    }

    /**
     * Logs a debug message.
     */
    private _log(message: string, ...args: unknown[]): void {
        if (this._debug) {
            console.log(`[RuntimeInspection] ${message}`, ...args);
        }
    }

    /**
     * Logs an error message.
     */
    private _error(message: string, ...args: unknown[]): void {
        console.error(`[RuntimeInspection] ${message}`, ...args);
    }

    /**
     * Initializes the service.
     */
    async initialize(): Promise<boolean> {
        this._log('Initializing runtime inspection service...');

        // Load configuration
        const config = this._configLoader.load();
        if (!config) {
            this._log('No configuration found, runtime inspection disabled');
            return false;
        }

        if (!config.enabled) {
            this._log('Runtime inspection is disabled in configuration');
            return false;
        }

        // Initialize inspection client
        this._inspectionClient = new InspectionClient({
            host: config.inspectionServer.host ?? 'localhost',
            port: config.inspectionServer.port,
        });

        // Check if inspection server is available
        const serverAvailable = await this._inspectionClient.checkHealth();
        if (!serverAvailable) {
            this._log('Inspection server not available at port', config.inspectionServer.port);
            // Don't fail initialization, server might come up later
        }

        // Connect to kernel if connection file is specified
        if (config.kernel.connectionFile) {
            try {
                await this._kernelClient.connect(config.kernel.connectionFile);
                this._log('Connected to kernel');
            } catch (error) {
                this._error('Failed to connect to kernel:', error);
                // Don't fail initialization, kernel might be started later
            }
        }

        // Start watching config for changes
        this._configLoader.startWatching((newConfig) => {
            this._log('Configuration changed');
            this._onConfigChange(newConfig);
        });

        this._isInitialized = true;
        this._log('Initialization complete');
        return true;
    }

    /**
     * Handles configuration changes.
     */
    private _onConfigChange(config: LspContextConfig | undefined): void {
        if (!config) {
            this._log('Configuration removed');
            return;
        }

        // Update inspection client if server settings changed
        if (this._inspectionClient) {
            const currentPort = this._configLoader.config?.inspectionServer.port;
            if (currentPort !== config.inspectionServer.port) {
                this._inspectionClient = new InspectionClient({
                    host: config.inspectionServer.host ?? 'localhost',
                    port: config.inspectionServer.port,
                });
            }
        }

        // Reconnect to kernel if connection file changed
        const currentKernel = this._configLoader.config?.kernel.connectionFile;
        if (currentKernel !== config.kernel.connectionFile) {
            this._kernelClient.disconnect();
            if (config.kernel.connectionFile) {
                this._kernelClient.connect(config.kernel.connectionFile).catch((error) => {
                    this._error('Failed to reconnect to kernel:', error);
                });
            }
        }
    }

    /**
     * Checks if runtime inspection is available.
     */
    isAvailable(): boolean {
        return (
            this._isInitialized &&
            this._configLoader.isEnabled() &&
            this._kernelClient.isConnected &&
            (this._inspectionClient?.isAvailable ?? false)
        );
    }

    /**
     * Checks if a type is configured for runtime inspection.
     */
    hasTypeConfig(fullyQualifiedType: string): boolean {
        return this._configLoader.getTypeConfig(fullyQualifiedType) !== undefined;
    }

    /**
     * Gets the configuration for a type.
     */
    getTypeConfig(fullyQualifiedType: string): TypeInspectionConfig | undefined {
        return this._configLoader.getTypeConfig(fullyQualifiedType);
    }

    /**
     * Performs runtime inspection for a hover event.
     *
     * This is the main entry point called from the hover provider.
     *
     * @param expression The Python expression being hovered
     * @param staticType The static type determined by Pyright
     * @returns Runtime inspection result with dynamic information
     */
    async inspectForHover(expression: string, staticType: string): Promise<RuntimeInspectionResult> {
        const startTime = Date.now();
        const timing: RuntimeInspectionResult['timing'] = { totalMs: 0 };

        this._log(`Inspecting: ${expression} (static type: ${staticType})`);

        // Check if inspection is enabled and available
        if (!this._configLoader.isEnabled()) {
            return {
                success: false,
                staticType,
                failureReason: InspectionFailureReason.ConfigNotFound,
                notes: ['Runtime inspection is disabled'],
                timing: { totalMs: Date.now() - startTime },
            };
        }

        // Check if type is configured
        const typeConfig = this._configLoader.getTypeConfig(staticType);
        if (!typeConfig) {
            return {
                success: false,
                staticType,
                failureReason: InspectionFailureReason.TypeNotConfigured,
                notes: [`No inspection configured for type: ${staticType}`],
                timing: { totalMs: Date.now() - startTime },
            };
        }

        // Check kernel connection
        if (!this._kernelClient.isConnected) {
            return {
                success: false,
                staticType,
                failureReason: InspectionFailureReason.KernelNotConnected,
                notes: ['Kernel is not connected'],
                timing: { totalMs: Date.now() - startTime },
            };
        }

        // Check inspection server
        if (!this._inspectionClient || !(await this._inspectionClient.ensureAvailable())) {
            return {
                success: false,
                staticType,
                failureReason: InspectionFailureReason.ServerUnavailable,
                notes: ['Inspection server is not available'],
                timing: { totalMs: Date.now() - startTime },
            };
        }

        try {
            // Step 1: Validate type in kernel
            const typeValidationStart = Date.now();
            const typeValidation = await this._kernelClient.validateType(expression, typeConfig.timeoutMs);
            timing.typeValidationMs = Date.now() - typeValidationStart;

            if (!typeValidation.exists) {
                return {
                    success: false,
                    staticType,
                    failureReason: InspectionFailureReason.ObjectNotFound,
                    notes: [typeValidation.error ?? 'Object not found in kernel'],
                    timing: { ...timing, totalMs: Date.now() - startTime },
                };
            }

            // Check for type mismatch
            const notes: string[] = [];
            if (typeValidation.runtimeType && !this._typesMatch(staticType, typeValidation.runtimeType)) {
                notes.push(
                    `Type mismatch: static type is ${staticType}, runtime type is ${typeValidation.runtimeType}`,
                );
                // Continue anyway, but include the warning
            }

            // Step 2: Check size
            const sizeCheckStart = Date.now();
            const sizeResult = await this._kernelClient.estimateSize(
                expression,
                typeValidation.runtimeType ?? staticType,
                typeConfig.timeoutMs,
            );
            timing.sizeCheckMs = Date.now() - sizeCheckStart;

            if (!sizeResult.success) {
                notes.push(`Size estimation failed: ${sizeResult.error}`);
                // Continue anyway, size check is best-effort
            } else if (sizeResult.sizeMb > typeConfig.maxSizeMb) {
                return {
                    success: false,
                    staticType,
                    failureReason: InspectionFailureReason.SizeExceeded,
                    notes: [
                        `Object size (${sizeResult.sizeMb.toFixed(2)} MB) exceeds limit (${typeConfig.maxSizeMb} MB)`,
                    ],
                    timing: { ...timing, totalMs: Date.now() - startTime },
                };
            }

            // Step 3: Serialize object
            const serializationStart = Date.now();
            const serialized = await this._kernelClient.serializeObject(
                expression,
                typeConfig.copyStrategy,
                typeConfig.timeoutMs,
            );
            timing.serializationMs = Date.now() - serializationStart;

            if (!serialized.success) {
                return {
                    success: false,
                    staticType,
                    failureReason: InspectionFailureReason.SerializationFailed,
                    notes: [serialized.error ?? 'Failed to serialize object'],
                    timing: { ...timing, totalMs: Date.now() - startTime },
                };
            }

            // Step 4: Send to inspection server
            const inspectionStart = Date.now();
            const inspectionId = crypto.randomUUID();
            const request = createInspectionRequest(
                inspectionId,
                typeValidation.runtimeType ?? staticType,
                serialized.payload,
                serialized.serialization,
                typeConfig.timeoutMs,
                typeConfig.resourceLimits,
            );

            const response = await this._inspectionClient.inspect(request);
            timing.inspectionMs = Date.now() - inspectionStart;

            if (!response.success) {
                const failureReason = response.error?.includes('timeout')
                    ? InspectionFailureReason.InspectionTimeout
                    : InspectionFailureReason.InspectionError;
                return {
                    success: false,
                    staticType,
                    failureReason,
                    notes: [response.error ?? 'Inspection failed'],
                    timing: { ...timing, totalMs: Date.now() - startTime },
                };
            }

            // Success!
            timing.totalMs = Date.now() - startTime;
            return {
                success: true,
                staticType,
                dynamicResult: response.result,
                notes: notes.length > 0 ? notes : undefined,
                timing,
            };
        } catch (error) {
            this._error('Inspection error:', error);
            return {
                success: false,
                staticType,
                failureReason: InspectionFailureReason.InspectionError,
                notes: [error instanceof Error ? error.message : String(error)],
                timing: { ...timing, totalMs: Date.now() - startTime },
            };
        }
    }

    /**
     * Checks if static and runtime types match.
     * Handles variations in module paths.
     */
    private _typesMatch(staticType: string, runtimeType: string): boolean {
        // Exact match
        if (staticType === runtimeType) {
            return true;
        }

        // Normalize and compare
        const normalizeType = (t: string): string => {
            // Remove common prefixes
            return t
                .replace(/^pandas\.core\.frame\./, 'pandas.')
                .replace(/^pandas\.core\.series\./, 'pandas.')
                .replace(/^numpy\./, 'numpy.')
                .replace(/^builtins\./, '');
        };

        return normalizeType(staticType) === normalizeType(runtimeType);
    }

    /**
     * Formats a runtime inspection result for hover display.
     */
    formatForHover(result: RuntimeInspectionResult): string {
        const parts: string[] = [];

        // Static type
        parts.push(`**Static Type:** \`${result.staticType}\``);

        // Dynamic result
        if (result.success && result.dynamicResult) {
            parts.push('');
            parts.push('**Runtime Inspection:**');
            parts.push('```');
            parts.push(result.dynamicResult);
            parts.push('```');
        }

        // Notes/warnings
        if (result.notes && result.notes.length > 0) {
            parts.push('');
            parts.push('**Notes:**');
            result.notes.forEach((note) => {
                parts.push(`- ${note}`);
            });
        }

        // Timing (debug mode only)
        if (this._debug && result.timing) {
            parts.push('');
            parts.push(`*Inspection time: ${result.timing.totalMs}ms*`);
        }

        return parts.join('\n');
    }

    /**
     * Connects to a kernel by connection file path.
     */
    async connectToKernel(connectionFilePath: string): Promise<void> {
        await this._kernelClient.connect(connectionFilePath);
    }

    /**
     * Disconnects from the current kernel.
     */
    disconnectKernel(): void {
        this._kernelClient.disconnect();
    }

    /**
     * Gets the kernel connection state.
     */
    get kernelState(): KernelConnectionState {
        return this._kernelClient.state;
    }

    /**
     * Disposes of resources.
     */
    dispose(): void {
        this._configLoader.dispose();
        this._kernelClient.dispose();
        this._isInitialized = false;
    }
}

// Singleton instance for the service
let _serviceInstance: RuntimeInspectionService | undefined;

/**
 * Gets or creates the runtime inspection service instance.
 */
export function getRuntimeInspectionService(workspaceRoot?: string): RuntimeInspectionService | undefined {
    if (!_serviceInstance && workspaceRoot) {
        _serviceInstance = new RuntimeInspectionService({ workspaceRoot });
    }
    return _serviceInstance;
}

/**
 * Disposes of the runtime inspection service.
 */
export function disposeRuntimeInspectionService(): void {
    if (_serviceInstance) {
        _serviceInstance.dispose();
        _serviceInstance = undefined;
    }
}
