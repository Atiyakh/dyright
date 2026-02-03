/*
 * types.ts
 * Copyright (c) 2026
 * Licensed under the MIT license.
 *
 * Type definitions for the runtime inspection system.
 * This module defines the configuration schema, inspection results,
 * and interfaces for kernel communication.
 */

/**
 * Copy strategy for serializing objects from the kernel.
 */
export interface CopyStrategy {
    /** Mode of copying: shallow, deep, or pickle */
    mode: 'shallow' | 'deep' | 'pickle';
    /** Maximum depth for nested object copying */
    maxDepth?: number;
}

/**
 * Resource limits for inspection execution.
 */
export interface ResourceLimits {
    /** Maximum RAM usage in megabytes */
    ramMb?: number;
    /** Maximum CPU usage as a percentage (0-100) */
    cpuPercent?: number;
}

/**
 * Configuration for inspecting a specific type.
 */
export interface TypeInspectionConfig {
    /** Maximum object size in megabytes before fallback */
    maxSizeMb: number;
    /** Timeout for inspection in milliseconds */
    timeoutMs: number;
    /** Strategy for copying objects from kernel */
    copyStrategy: CopyStrategy;
    /** Resource limits for inspection execution */
    resourceLimits?: ResourceLimits;
    /** Path to the inspection script (relative to workspace or absolute) */
    inspectionCode: string;
}

/**
 * Kernel connection configuration.
 */
export interface KernelConfig {
    /** Unique identifier for the kernel */
    id?: string;
    /** Path to the Jupyter kernel connection file */
    connectionFile: string;
}

/**
 * Inspection server configuration.
 */
export interface InspectionServerConfig {
    /** Port for the HTTP inspection server */
    port: number;
    /** Host address (default: localhost) */
    host?: string;
}

/**
 * Root configuration schema for lspContext.json.
 */
export interface LspContextConfig {
    /** Kernel connection settings */
    kernel: KernelConfig;
    /** Inspection server settings */
    inspectionServer: InspectionServerConfig;
    /** Type-specific inspection configurations */
    typeInspections: Record<string, TypeInspectionConfig>;
    /** Enable/disable runtime inspection globally */
    enabled?: boolean;
    /** Debug mode for additional logging */
    debug?: boolean;
}

/**
 * Result from kernel type validation.
 */
export interface KernelTypeValidationResult {
    /** Whether the object exists in the kernel */
    exists: boolean;
    /** Fully qualified runtime type name */
    runtimeType?: string;
    /** Error message if validation failed */
    error?: string;
}

/**
 * Result from kernel size estimation.
 */
export interface KernelSizeResult {
    /** Size in megabytes */
    sizeMb: number;
    /** Whether size estimation succeeded */
    success: boolean;
    /** Error message if estimation failed */
    error?: string;
}

/**
 * Serialized object payload from kernel.
 */
export interface SerializedPayload {
    /** Serialization method used */
    serialization: 'pickle' | 'json' | 'custom';
    /** Base64-encoded payload */
    payload: string;
    /** Whether serialization succeeded */
    success: boolean;
    /** Error message if serialization failed */
    error?: string;
}

/**
 * Request payload for the inspection server.
 */
export interface InspectionRequest {
    /** Unique identifier for this inspection */
    inspectionId: string;
    /** Fully qualified type name */
    type: string;
    /** Serialization method */
    serialization: string;
    /** Base64-encoded serialized object */
    payload: string;
    /** Timeout in milliseconds */
    timeoutMs: number;
    /** Resource limits */
    resourceLimits?: ResourceLimits;
}

/**
 * Response from the inspection server.
 */
export interface InspectionResponse {
    /** Unique identifier matching the request */
    inspectionId: string;
    /** Whether inspection succeeded */
    success: boolean;
    /** Inspection result string (for hover display) */
    result?: string;
    /** Error message if inspection failed */
    error?: string;
    /** Execution time in milliseconds */
    executionTimeMs?: number;
}

/**
 * Failure reason enumeration.
 */
export enum InspectionFailureReason {
    KernelNotConnected = 'KERNEL_NOT_CONNECTED',
    ObjectNotFound = 'OBJECT_NOT_FOUND',
    TypeMismatch = 'TYPE_MISMATCH',
    SizeExceeded = 'SIZE_EXCEEDED',
    SerializationFailed = 'SERIALIZATION_FAILED',
    InspectionTimeout = 'INSPECTION_TIMEOUT',
    InspectionError = 'INSPECTION_ERROR',
    ServerUnavailable = 'SERVER_UNAVAILABLE',
    ConfigNotFound = 'CONFIG_NOT_FOUND',
    TypeNotConfigured = 'TYPE_NOT_CONFIGURED',
}

/**
 * Result of the complete runtime inspection flow.
 */
export interface RuntimeInspectionResult {
    /** Whether runtime inspection was successful */
    success: boolean;
    /** Static type from Pyright analysis */
    staticType: string;
    /** Runtime inspection result (if successful) */
    dynamicResult?: string;
    /** Failure reason (if unsuccessful) */
    failureReason?: InspectionFailureReason;
    /** Human-readable notes or warnings */
    notes?: string[];
    /** Timing information */
    timing?: {
        typeValidationMs?: number;
        sizeCheckMs?: number;
        serializationMs?: number;
        inspectionMs?: number;
        totalMs: number;
    };
}

/**
 * Jupyter kernel connection file schema (kernel-*.json).
 */
export interface JupyterConnectionInfo {
    shell_port: number;
    iopub_port: number;
    stdin_port: number;
    control_port: number;
    hb_port: number;
    ip: string;
    key: string;
    transport: 'tcp' | 'ipc';
    signature_scheme: string;
    kernel_name?: string;
}

/**
 * Message types for Jupyter wire protocol.
 */
export type JupyterMessageType = 'execute_request' | 'execute_reply' | 'execute_result' | 'stream' | 'error' | 'status';

/**
 * Jupyter message header.
 */
export interface JupyterMessageHeader {
    msg_id: string;
    session: string;
    username: string;
    date: string;
    msg_type: JupyterMessageType;
    version: string;
}

/**
 * Generic Jupyter message structure.
 */
export interface JupyterMessage<T = unknown> {
    header: JupyterMessageHeader;
    parent_header: JupyterMessageHeader | Record<string, never>;
    metadata: Record<string, unknown>;
    content: T;
    buffers?: ArrayBuffer[];
}

/**
 * Execute request content.
 */
export interface ExecuteRequestContent {
    code: string;
    silent?: boolean;
    store_history?: boolean;
    user_expressions?: Record<string, string>;
    allow_stdin?: boolean;
    stop_on_error?: boolean;
}

/**
 * Execute reply content.
 */
export interface ExecuteReplyContent {
    status: 'ok' | 'error' | 'aborted';
    execution_count?: number;
    user_expressions?: Record<string, unknown>;
    // Error fields
    ename?: string;
    evalue?: string;
    traceback?: string[];
}
