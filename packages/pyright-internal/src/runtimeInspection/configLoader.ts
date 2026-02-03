/*
 * configLoader.ts
 * Copyright (c) 2026
 * Licensed under the MIT license.
 *
 * Loads and validates lspContext.json configuration for runtime inspection.
 */

import * as fs from 'fs';
import * as path from 'path';
import { LspContextConfig, TypeInspectionConfig } from './types';

const CONFIG_FILENAME = 'lspContext.json';

/**
 * Default configuration values.
 */
const DEFAULT_CONFIG: Partial<LspContextConfig> = {
    enabled: true,
    debug: false,
    inspectionServer: {
        port: 8765,
        host: 'localhost',
    },
};

/**
 * Default inspection configuration for common types.
 */
const DEFAULT_TYPE_INSPECTIONS: Record<string, Partial<TypeInspectionConfig>> = {
    'pandas.DataFrame': {
        maxSizeMb: 50,
        timeoutMs: 2000,
        copyStrategy: { mode: 'shallow', maxDepth: 1 },
        resourceLimits: { ramMb: 256, cpuPercent: 50 },
    },
    'pandas.Series': {
        maxSizeMb: 20,
        timeoutMs: 1000,
        copyStrategy: { mode: 'shallow', maxDepth: 1 },
        resourceLimits: { ramMb: 128, cpuPercent: 50 },
    },
    'numpy.ndarray': {
        maxSizeMb: 100,
        timeoutMs: 1000,
        copyStrategy: { mode: 'shallow', maxDepth: 1 },
        resourceLimits: { ramMb: 256, cpuPercent: 50 },
    },
};

/**
 * Validation result for configuration.
 */
export interface ConfigValidationResult {
    valid: boolean;
    errors: string[];
    warnings: string[];
}

/**
 * Validates a type inspection configuration.
 */
function validateTypeInspection(
    typeName: string,
    config: TypeInspectionConfig,
): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (typeof config.maxSizeMb !== 'number' || config.maxSizeMb <= 0) {
        errors.push(`${typeName}: maxSizeMb must be a positive number`);
    }

    if (typeof config.timeoutMs !== 'number' || config.timeoutMs <= 0) {
        errors.push(`${typeName}: timeoutMs must be a positive number`);
    }

    if (!config.copyStrategy) {
        errors.push(`${typeName}: copyStrategy is required`);
    } else {
        const validModes = ['shallow', 'deep', 'pickle'];
        if (!validModes.includes(config.copyStrategy.mode)) {
            errors.push(`${typeName}: copyStrategy.mode must be one of: ${validModes.join(', ')}`);
        }
    }

    if (!config.inspectionCode) {
        errors.push(`${typeName}: inspectionCode path is required`);
    }

    if (config.resourceLimits) {
        if (config.resourceLimits.ramMb !== undefined && config.resourceLimits.ramMb <= 0) {
            warnings.push(`${typeName}: resourceLimits.ramMb should be positive`);
        }
        if (
            config.resourceLimits.cpuPercent !== undefined &&
            (config.resourceLimits.cpuPercent <= 0 || config.resourceLimits.cpuPercent > 100)
        ) {
            warnings.push(`${typeName}: resourceLimits.cpuPercent should be between 1 and 100`);
        }
    }

    return { errors, warnings };
}

/**
 * Validates the complete configuration.
 */
export function validateConfig(config: LspContextConfig): ConfigValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate kernel config
    if (!config.kernel) {
        errors.push('kernel configuration is required');
    } else if (!config.kernel.connectionFile) {
        errors.push('kernel.connectionFile is required');
    }

    // Validate inspection server config
    if (!config.inspectionServer) {
        warnings.push('inspectionServer not configured, using defaults');
    } else if (
        typeof config.inspectionServer.port !== 'number' ||
        config.inspectionServer.port < 1 ||
        config.inspectionServer.port > 65535
    ) {
        errors.push('inspectionServer.port must be a valid port number (1-65535)');
    }

    // Validate type inspections
    if (config.typeInspections) {
        for (const [typeName, typeConfig] of Object.entries(config.typeInspections)) {
            const validation = validateTypeInspection(typeName, typeConfig);
            errors.push(...validation.errors);
            warnings.push(...validation.warnings);
        }
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings,
    };
}

/**
 * Configuration loader class.
 */
export class ConfigLoader {
    private _config: LspContextConfig | undefined;
    private _configPath: string | undefined;
    private _lastLoadTime: number = 0;
    private _fileWatcher: fs.FSWatcher | undefined;
    private _onConfigChange: ((config: LspContextConfig | undefined) => void) | undefined;

    constructor(private readonly _workspaceRoot: string) {}

    /**
     * Gets the current configuration.
     */
    get config(): LspContextConfig | undefined {
        return this._config;
    }

    /**
     * Gets the configuration file path.
     */
    get configPath(): string | undefined {
        return this._configPath;
    }

    /**
     * Searches for lspContext.json in the workspace.
     */
    findConfigFile(): string | undefined {
        const searchPaths = [
            path.join(this._workspaceRoot, CONFIG_FILENAME),
            path.join(this._workspaceRoot, '.vscode', CONFIG_FILENAME),
            path.join(this._workspaceRoot, '.jupyter', CONFIG_FILENAME),
        ];

        for (const searchPath of searchPaths) {
            if (fs.existsSync(searchPath)) {
                return searchPath;
            }
        }

        return undefined;
    }

    /**
     * Loads configuration from the workspace.
     */
    load(): LspContextConfig | undefined {
        const configPath = this.findConfigFile();

        if (!configPath) {
            this._config = undefined;
            this._configPath = undefined;
            return undefined;
        }

        try {
            const content = fs.readFileSync(configPath, 'utf-8');
            const rawConfig = JSON.parse(content) as LspContextConfig;

            // Merge with defaults
            const config: LspContextConfig = {
                ...DEFAULT_CONFIG,
                ...rawConfig,
                inspectionServer: {
                    ...DEFAULT_CONFIG.inspectionServer,
                    ...rawConfig.inspectionServer,
                },
                typeInspections: {
                    ...rawConfig.typeInspections,
                },
            };

            // Validate
            const validation = validateConfig(config);
            if (!validation.valid) {
                console.error(`[RuntimeInspection] Configuration errors in ${configPath}:`);
                validation.errors.forEach((err) => console.error(`  - ${err}`));
                return undefined;
            }

            if (validation.warnings.length > 0) {
                console.warn(`[RuntimeInspection] Configuration warnings in ${configPath}:`);
                validation.warnings.forEach((warn) => console.warn(`  - ${warn}`));
            }

            this._config = config;
            this._configPath = configPath;
            this._lastLoadTime = Date.now();

            return config;
        } catch (error) {
            console.error(`[RuntimeInspection] Failed to load config from ${configPath}:`, error);
            this._config = undefined;
            return undefined;
        }
    }

    /**
     * Reloads configuration if the file has changed.
     */
    reload(): boolean {
        if (!this._configPath) {
            return this.load() !== undefined;
        }

        try {
            const stat = fs.statSync(this._configPath);
            if (stat.mtimeMs > this._lastLoadTime) {
                this.load();
                return true;
            }
        } catch {
            // File might have been deleted
            this._config = undefined;
            this._configPath = undefined;
        }

        return false;
    }

    /**
     * Starts watching the configuration file for changes.
     */
    startWatching(onChange?: (config: LspContextConfig | undefined) => void): void {
        this._onConfigChange = onChange;
        this.stopWatching();

        if (!this._configPath) {
            return;
        }

        try {
            this._fileWatcher = fs.watch(this._configPath, (eventType) => {
                if (eventType === 'change') {
                    this.load();
                    this._onConfigChange?.(this._config);
                }
            });
        } catch (error) {
            console.error('[RuntimeInspection] Failed to watch config file:', error);
        }
    }

    /**
     * Stops watching the configuration file.
     */
    stopWatching(): void {
        if (this._fileWatcher) {
            this._fileWatcher.close();
            this._fileWatcher = undefined;
        }
    }

    /**
     * Gets the inspection configuration for a specific type.
     */
    getTypeConfig(fullyQualifiedType: string): TypeInspectionConfig | undefined {
        if (!this._config?.typeInspections) {
            return undefined;
        }

        // Exact match
        if (this._config.typeInspections[fullyQualifiedType]) {
            return this._config.typeInspections[fullyQualifiedType];
        }

        // Try without module prefix variations
        // e.g., "pandas.core.frame.DataFrame" should match "pandas.DataFrame"
        const parts = fullyQualifiedType.split('.');
        if (parts.length > 2) {
            const shortName = `${parts[0]}.${parts[parts.length - 1]}`;
            if (this._config.typeInspections[shortName]) {
                return this._config.typeInspections[shortName];
            }
        }

        return undefined;
    }

    /**
     * Checks if runtime inspection is enabled.
     */
    isEnabled(): boolean {
        return this._config?.enabled ?? false;
    }

    /**
     * Checks if debug mode is enabled.
     */
    isDebugMode(): boolean {
        return this._config?.debug ?? false;
    }

    /**
     * Disposes of resources.
     */
    dispose(): void {
        this.stopWatching();
        this._config = undefined;
    }
}

/**
 * Creates a sample lspContext.json configuration.
 */
export function createSampleConfig(): LspContextConfig {
    return {
        kernel: {
            id: 'my-kernel-uuid',
            connectionFile: '/path/to/kernel-uuid.json',
        },
        inspectionServer: {
            port: 8765,
            host: 'localhost',
        },
        enabled: true,
        debug: false,
        typeInspections: {
            'pandas.DataFrame': {
                maxSizeMb: 50,
                timeoutMs: 2000,
                copyStrategy: {
                    mode: 'shallow',
                    maxDepth: 1,
                },
                resourceLimits: {
                    ramMb: 256,
                    cpuPercent: 50,
                },
                inspectionCode: 'inspection_scripts/dataframe.py',
            },
            'pandas.Series': {
                maxSizeMb: 20,
                timeoutMs: 1000,
                copyStrategy: {
                    mode: 'shallow',
                    maxDepth: 1,
                },
                resourceLimits: {
                    ramMb: 128,
                    cpuPercent: 50,
                },
                inspectionCode: 'inspection_scripts/series.py',
            },
            'numpy.ndarray': {
                maxSizeMb: 100,
                timeoutMs: 1000,
                copyStrategy: {
                    mode: 'shallow',
                    maxDepth: 1,
                },
                resourceLimits: {
                    ramMb: 256,
                    cpuPercent: 50,
                },
                inspectionCode: 'inspection_scripts/ndarray.py',
            },
        },
    };
}
