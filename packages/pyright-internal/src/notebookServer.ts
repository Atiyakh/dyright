/*
 * notebookServer.ts
 * Copyright (c) 2026
 * Licensed under the MIT license.
 *
 * Implements notebook-aware pyright language server with runtime inspection.
 * This server extends the standard PyrightServer with capabilities for
 * dynamic type inspection in Jupyter notebook environments.
 */

import { Connection } from 'vscode-languageserver';

import { FileSystem } from './common/fileSystem';
import { RuntimeAwareHoverOptions } from './languageService/runtimeAwareHoverProvider';
import { getRuntimeInspectionService, RuntimeInspectionService } from './runtimeInspection';
import { PyrightServer } from './server';
import { Workspace } from './workspaceFactory';

/**
 * Options for the notebook server.
 */
export interface NotebookServerOptions {
    /** Workspace root for finding lspContext.json */
    workspaceRoot: string;
    /** Enable runtime inspection */
    enableRuntimeInspection?: boolean;
    /** Runtime inspection timeout in milliseconds */
    inspectionTimeoutMs?: number;
    /** Show timing information in hover */
    showTimingInfo?: boolean;
    /** Enable debug logging */
    debug?: boolean;
}

const DEFAULT_NOTEBOOK_OPTIONS: Partial<NotebookServerOptions> = {
    enableRuntimeInspection: true,
    inspectionTimeoutMs: 3000,
    showTimingInfo: false,
    debug: false,
};

/**
 * Notebook-aware Pyright server with runtime inspection capabilities.
 *
 * This server extends the standard PyrightServer with:
 * - Runtime inspection service integration
 * - Kernel connection management
 * - Enhanced hover with dynamic type information
 */
export class NotebookServer extends PyrightServer {
    private readonly _notebookOptions: NotebookServerOptions;
    private _runtimeService: RuntimeInspectionService | undefined;
    private _initializationPromise: Promise<void> | undefined;

    constructor(
        connection: Connection,
        maxWorkers: number,
        realFileSystem?: FileSystem,
        notebookOptions?: NotebookServerOptions,
    ) {
        super(connection, maxWorkers, realFileSystem);

        this._notebookOptions = {
            ...DEFAULT_NOTEBOOK_OPTIONS,
            workspaceRoot: '',
            ...notebookOptions,
        };

        // Initialize runtime inspection asynchronously
        if (this._notebookOptions.enableRuntimeInspection && this._notebookOptions.workspaceRoot) {
            this._initializationPromise = this._initializeRuntimeInspection();
        }
    }

    /**
     * Initializes the runtime inspection service.
     */
    private async _initializeRuntimeInspection(): Promise<void> {
        try {
            this.console.info('[NotebookServer] Initializing runtime inspection...');

            // Get the runtime inspection service
            this._runtimeService = getRuntimeInspectionService(this._notebookOptions.workspaceRoot);

            if (!this._runtimeService) {
                this.console.info('[NotebookServer] No workspace root provided');
                return;
            }

            // Initialize the service
            const initialized = await this._runtimeService.initialize();

            if (initialized) {
                this.console.info('[NotebookServer] Runtime inspection service initialized');
            } else {
                this.console.info('[NotebookServer] Runtime inspection disabled (no config or not enabled)');
            }
        } catch (error) {
            this.console.error(`[NotebookServer] Failed to initialize runtime inspection: ${error}`);
        }
    }

    /**
     * Gets the runtime inspection service for a workspace.
     * Overrides the base class method to provide the actual service.
     */
    protected override getRuntimeInspectionService(_workspace: Workspace): RuntimeInspectionService | undefined {
        return this._runtimeService;
    }

    /**
     * Gets runtime hover options.
     * Overrides the base class method to provide notebook-specific options.
     */
    protected override getRuntimeHoverOptions(): Partial<RuntimeAwareHoverOptions> | undefined {
        return {
            enableRuntimeInspection: this._notebookOptions.enableRuntimeInspection,
            runtimeInspectionTimeoutMs: this._notebookOptions.inspectionTimeoutMs,
            showTimingInfo: this._notebookOptions.showTimingInfo,
        };
    }

    /**
     * Disposes of the server and its resources.
     */
    override dispose(): void {
        // Dispose runtime inspection service
        if (this._runtimeService) {
            this._runtimeService.dispose();
            this._runtimeService = undefined;
        }

        // Call parent dispose
        super.dispose();
    }

    /**
     * Returns whether runtime inspection is available.
     */
    isRuntimeInspectionAvailable(): boolean {
        return this._runtimeService?.isAvailable() ?? false;
    }

    /**
     * Waits for initialization to complete.
     */
    async waitForInitialization(): Promise<void> {
        if (this._initializationPromise) {
            await this._initializationPromise;
        }
    }
}

/**
 * Creates a notebook server instance.
 */
export function createNotebookServer(
    connection: Connection,
    maxWorkers: number,
    realFileSystem?: FileSystem,
    options?: NotebookServerOptions,
): NotebookServer {
    return new NotebookServer(connection, maxWorkers, realFileSystem, options);
}
