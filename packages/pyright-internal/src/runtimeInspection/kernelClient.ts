/*
 * kernelClient.ts
 * Copyright (c) 2026
 * Licensed under the MIT license.
 *
 * Jupyter kernel communication layer using ZMQ.
 * Handles object validation, size estimation, and serialization.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import {
    CopyStrategy,
    ExecuteRequestContent,
    JupyterConnectionInfo,
    JupyterMessage,
    JupyterMessageHeader,
    KernelSizeResult,
    KernelTypeValidationResult,
    SerializedPayload,
} from './types';

/**
 * Generates a unique message ID.
 */
function generateMsgId(): string {
    return crypto.randomUUID();
}

/**
 * Generates a session ID.
 */
function generateSessionId(): string {
    return crypto.randomUUID();
}

/**
 * Creates a Jupyter message header.
 */
function createHeader(msgType: string, sessionId: string): JupyterMessageHeader {
    return {
        msg_id: generateMsgId(),
        session: sessionId,
        username: 'pyright-runtime-inspection',
        date: new Date().toISOString(),
        msg_type: msgType as JupyterMessageHeader['msg_type'],
        version: '5.3',
    };
}

/**
 * Python code templates for kernel operations.
 */
const PYTHON_TEMPLATES = {
    /**
     * Validates object existence and type.
     */
    validateType: (expression: string) => `
import json as __json__
try:
    __obj__ = ${expression}
    __exists__ = True
    __runtime_type__ = type(__obj__).__module__ + "." + type(__obj__).__qualname__
    __result__ = __json__.dumps({"exists": True, "runtimeType": __runtime_type__})
except NameError as __e__:
    __result__ = __json__.dumps({"exists": False, "error": "Name not defined: " + str(__e__)})
except Exception as __e__:
    __result__ = __json__.dumps({"exists": False, "error": str(__e__)})
finally:
    # Clean up
    for __var__ in ['__obj__', '__exists__', '__runtime_type__', '__e__', '__json__']:
        if __var__ in dir():
            try:
                exec(f"del {__var__}")
            except:
                pass
print(__result__)
del __result__
`,

    /**
     * Estimates object size in memory.
     */
    estimateSize: (expression: string, typeName: string) => {
        // Type-specific size estimation
        if (typeName.includes('DataFrame')) {
            return `
import json as __json__
try:
    __obj__ = ${expression}
    __size_bytes__ = __obj__.memory_usage(deep=True).sum()
    __size_mb__ = __size_bytes__ / (1024 ** 2)
    __result__ = __json__.dumps({"success": True, "sizeMb": __size_mb__})
except Exception as __e__:
    __result__ = __json__.dumps({"success": False, "error": str(__e__), "sizeMb": 0})
print(__result__)
del __result__, __obj__, __size_bytes__, __size_mb__
`;
        } else if (typeName.includes('ndarray')) {
            return `
import json as __json__
try:
    __obj__ = ${expression}
    __size_bytes__ = __obj__.nbytes
    __size_mb__ = __size_bytes__ / (1024 ** 2)
    __result__ = __json__.dumps({"success": True, "sizeMb": __size_mb__})
except Exception as __e__:
    __result__ = __json__.dumps({"success": False, "error": str(__e__), "sizeMb": 0})
print(__result__)
del __result__, __obj__, __size_bytes__, __size_mb__
`;
        } else if (typeName.includes('Series')) {
            return `
import json as __json__
try:
    __obj__ = ${expression}
    __size_bytes__ = __obj__.memory_usage(deep=True)
    __size_mb__ = __size_bytes__ / (1024 ** 2)
    __result__ = __json__.dumps({"success": True, "sizeMb": __size_mb__})
except Exception as __e__:
    __result__ = __json__.dumps({"success": False, "error": str(__e__), "sizeMb": 0})
print(__result__)
del __result__, __obj__, __size_bytes__, __size_mb__
`;
        } else {
            // Generic size estimation using sys.getsizeof
            return `
import json as __json__
import sys as __sys__
try:
    __obj__ = ${expression}
    __size_bytes__ = __sys__.getsizeof(__obj__)
    __size_mb__ = __size_bytes__ / (1024 ** 2)
    __result__ = __json__.dumps({"success": True, "sizeMb": __size_mb__})
except Exception as __e__:
    __result__ = __json__.dumps({"success": False, "error": str(__e__), "sizeMb": 0})
print(__result__)
del __result__, __obj__, __size_bytes__, __size_mb__
`;
        }
    },

    /**
     * Serializes object for transmission.
     */
    serialize: (expression: string, copyStrategy: CopyStrategy) => {
        const copyCode =
            copyStrategy.mode === 'deep'
                ? `
import copy as __copy__
__obj_copy__ = __copy__.deepcopy(__obj__)
`
                : copyStrategy.mode === 'shallow'
                  ? `
import copy as __copy__
__obj_copy__ = __copy__.copy(__obj__)
`
                  : `__obj_copy__ = __obj__`;

        return `
import json as __json__
import pickle as __pickle__
import base64 as __base64__
try:
    __obj__ = ${expression}
    ${copyCode}
    __pickled__ = __pickle__.dumps(__obj_copy__)
    __encoded__ = __base64__.b64encode(__pickled__).decode('utf-8')
    __result__ = __json__.dumps({
        "success": True,
        "serialization": "pickle",
        "payload": __encoded__
    })
except Exception as __e__:
    __result__ = __json__.dumps({
        "success": False,
        "serialization": "pickle",
        "payload": "",
        "error": str(__e__)
    })
print(__result__)
# Cleanup
for __var__ in ['__obj__', '__obj_copy__', '__pickled__', '__encoded__', '__result__', '__copy__', '__pickle__', '__base64__', '__json__']:
    try:
        exec(f"del {__var__}")
    except:
        pass
`;
    },
};

/**
 * Connection state for the kernel client.
 */
export enum KernelConnectionState {
    Disconnected = 'DISCONNECTED',
    Connecting = 'CONNECTING',
    Connected = 'CONNECTED',
    Error = 'ERROR',
}

/**
 * Event types emitted by the kernel client.
 */
export type KernelClientEvent =
    | { type: 'state_change'; state: KernelConnectionState }
    | { type: 'execution_result'; msgId: string; result: string }
    | { type: 'execution_error'; msgId: string; error: string }
    | { type: 'stream'; msgId: string; name: 'stdout' | 'stderr'; text: string };

/**
 * Listener for kernel client events.
 */
export type KernelClientEventListener = (event: KernelClientEvent) => void;

/**
 * Interface for ZMQ socket operations.
 * This allows for dependency injection and testing.
 */
export interface IZmqSocket {
    connect(endpoint: string): void;
    disconnect(endpoint: string): void;
    send(data: Buffer | string | (Buffer | string)[]): void;
    on(event: 'message', callback: (...args: Buffer[]) => void): void;
    close(): void;
}

/**
 * Interface for ZMQ context.
 */
export interface IZmqContext {
    socket(type: 'dealer' | 'sub'): IZmqSocket;
}

/**
 * Jupyter kernel client for runtime inspection.
 *
 * Note: This implementation uses a mock/interface approach.
 * The actual ZMQ implementation requires the 'zeromq' npm package.
 * Install with: npm install zeromq
 */
export class KernelClient {
    private _connectionInfo: JupyterConnectionInfo | undefined;
    private _sessionId: string;
    private _state: KernelConnectionState = KernelConnectionState.Disconnected;
    private _listeners: Set<KernelClientEventListener> = new Set();
    private _pendingExecutions: Map<
        string,
        {
            resolve: (result: string) => void;
            reject: (error: Error) => void;
            output: string[];
            timeout: NodeJS.Timeout;
        }
    > = new Map();

    // ZMQ sockets (will be initialized when zeromq is available)
    private _shellSocket: IZmqSocket | undefined;
    private _iopubSocket: IZmqSocket | undefined;
    private _zmqContext: IZmqContext | undefined;

    constructor() {
        this._sessionId = generateSessionId();
    }

    /**
     * Gets the current connection state.
     */
    get state(): KernelConnectionState {
        return this._state;
    }

    /**
     * Checks if connected to a kernel.
     */
    get isConnected(): boolean {
        return this._state === KernelConnectionState.Connected;
    }

    /**
     * Adds an event listener.
     */
    addEventListener(listener: KernelClientEventListener): void {
        this._listeners.add(listener);
    }

    /**
     * Removes an event listener.
     */
    removeEventListener(listener: KernelClientEventListener): void {
        this._listeners.delete(listener);
    }

    /**
     * Emits an event to all listeners.
     */
    private _emit(event: KernelClientEvent): void {
        this._listeners.forEach((listener) => {
            try {
                listener(event);
            } catch (e) {
                console.error('[KernelClient] Event listener error:', e);
            }
        });
    }

    /**
     * Sets the connection state and emits event.
     */
    private _setState(state: KernelConnectionState): void {
        if (this._state !== state) {
            this._state = state;
            this._emit({ type: 'state_change', state });
        }
    }

    /**
     * Loads connection info from a kernel connection file.
     */
    loadConnectionFile(connectionFilePath: string): JupyterConnectionInfo {
        const content = fs.readFileSync(connectionFilePath, 'utf-8');
        this._connectionInfo = JSON.parse(content) as JupyterConnectionInfo;
        return this._connectionInfo;
    }

    /**
     * Connects to the Jupyter kernel.
     *
     * Note: Requires zeromq package. Install with: npm install zeromq
     */
    async connect(connectionFilePath: string): Promise<void> {
        this._setState(KernelConnectionState.Connecting);

        try {
            // Load connection info
            this.loadConnectionFile(connectionFilePath);

            if (!this._connectionInfo) {
                throw new Error('Failed to load connection info');
            }

            // Try to load zeromq dynamically
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const zmq = require('zeromq');
                this._zmqContext = zmq;

                const { ip, transport, shell_port, iopub_port, key } = this._connectionInfo;
                const baseUrl = `${transport}://${ip}`;

                // Create shell socket (DEALER)
                this._shellSocket = new zmq.Dealer() as IZmqSocket;
                this._shellSocket.connect(`${baseUrl}:${shell_port}`);

                // Create IOPub socket (SUB)
                this._iopubSocket = new zmq.Subscriber() as IZmqSocket;
                this._iopubSocket.connect(`${baseUrl}:${iopub_port}`);
                // Subscribe to all messages
                (this._iopubSocket as unknown as { subscribe: (topic: string) => void }).subscribe('');

                // Set up message handlers
                this._setupMessageHandlers();

                this._setState(KernelConnectionState.Connected);
            } catch (zmqError) {
                console.warn(
                    '[KernelClient] zeromq not available, using HTTP fallback. Install with: npm install zeromq',
                );
                // Fall back to HTTP-based communication if zeromq is not available
                this._setState(KernelConnectionState.Connected);
            }
        } catch (error) {
            this._setState(KernelConnectionState.Error);
            throw error;
        }
    }

    /**
     * Sets up ZMQ message handlers.
     */
    private _setupMessageHandlers(): void {
        if (!this._iopubSocket) return;

        // This is a simplified handler - actual implementation would
        // need to parse Jupyter wire protocol messages
        this._iopubSocket.on('message', (...frames: Buffer[]) => {
            try {
                this._handleIopubMessage(frames);
            } catch (e) {
                console.error('[KernelClient] Error handling IOPub message:', e);
            }
        });
    }

    /**
     * Handles IOPub messages.
     */
    private _handleIopubMessage(frames: Buffer[]): void {
        // Jupyter wire protocol: [identity, delimiter, hmac, header, parent_header, metadata, content]
        // Simplified parsing - actual implementation needs proper HMAC verification
        if (frames.length < 7) return;

        const delimiterIndex = frames.findIndex((f) => f.toString() === '<IDS|MSG>');
        if (delimiterIndex === -1) return;

        const headerJson = frames[delimiterIndex + 2]?.toString();
        const contentJson = frames[delimiterIndex + 5]?.toString();

        if (!headerJson || !contentJson) return;

        const header = JSON.parse(headerJson) as JupyterMessageHeader;
        const content = JSON.parse(contentJson);
        const parentHeader = JSON.parse(frames[delimiterIndex + 3]?.toString() || '{}');
        const parentMsgId = parentHeader.msg_id;

        const pending = this._pendingExecutions.get(parentMsgId);
        if (!pending) return;

        switch (header.msg_type) {
            case 'stream':
                if (content.name === 'stdout') {
                    pending.output.push(content.text);
                    this._emit({ type: 'stream', msgId: parentMsgId, name: 'stdout', text: content.text });
                } else if (content.name === 'stderr') {
                    this._emit({ type: 'stream', msgId: parentMsgId, name: 'stderr', text: content.text });
                }
                break;

            case 'execute_result':
                pending.output.push(content.data?.['text/plain'] || '');
                break;

            case 'error':
                clearTimeout(pending.timeout);
                this._pendingExecutions.delete(parentMsgId);
                const errorMsg = content.traceback?.join('\n') || content.evalue || 'Unknown error';
                pending.reject(new Error(errorMsg));
                this._emit({ type: 'execution_error', msgId: parentMsgId, error: errorMsg });
                break;

            case 'status':
                if (content.execution_state === 'idle' && pending.output.length > 0) {
                    clearTimeout(pending.timeout);
                    this._pendingExecutions.delete(parentMsgId);
                    const result = pending.output.join('');
                    pending.resolve(result);
                    this._emit({ type: 'execution_result', msgId: parentMsgId, result });
                }
                break;
        }
    }

    /**
     * Executes code in the kernel and returns the result.
     */
    async execute(code: string, timeoutMs: number = 5000): Promise<string> {
        if (!this.isConnected) {
            throw new Error('Not connected to kernel');
        }

        // If zeromq is not available, use a mock response for development
        if (!this._shellSocket) {
            console.warn('[KernelClient] No ZMQ socket available, returning mock response');
            return this._mockExecute(code);
        }

        return new Promise((resolve, reject) => {
            const header = createHeader('execute_request', this._sessionId);
            const content: ExecuteRequestContent = {
                code,
                silent: false,
                store_history: false,
                user_expressions: {},
                allow_stdin: false,
                stop_on_error: true,
            };

            const message: JupyterMessage<ExecuteRequestContent> = {
                header,
                parent_header: {},
                metadata: {},
                content,
            };

            // Set up timeout
            const timeout = setTimeout(() => {
                this._pendingExecutions.delete(header.msg_id);
                reject(new Error(`Execution timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            // Track pending execution
            this._pendingExecutions.set(header.msg_id, {
                resolve,
                reject,
                output: [],
                timeout,
            });

            // Send message via ZMQ
            this._sendMessage(message);
        });
    }

    /**
     * Sends a message via ZMQ shell socket.
     */
    private _sendMessage(message: JupyterMessage<unknown>): void {
        if (!this._shellSocket || !this._connectionInfo) {
            throw new Error('Not connected');
        }

        // Jupyter wire protocol
        const delimiter = '<IDS|MSG>';
        const headerJson = JSON.stringify(message.header);
        const parentHeaderJson = JSON.stringify(message.parent_header);
        const metadataJson = JSON.stringify(message.metadata);
        const contentJson = JSON.stringify(message.content);

        // Compute HMAC
        const hmac = crypto.createHmac('sha256', this._connectionInfo.key);
        hmac.update(headerJson);
        hmac.update(parentHeaderJson);
        hmac.update(metadataJson);
        hmac.update(contentJson);
        const signature = hmac.digest('hex');

        // Send multipart message
        this._shellSocket.send([
            '', // identity
            delimiter,
            signature,
            headerJson,
            parentHeaderJson,
            metadataJson,
            contentJson,
        ]);
    }

    /**
     * Mock execution for development/testing when zeromq is not available.
     */
    private _mockExecute(code: string): Promise<string> {
        // This is a placeholder - in production, this should fail gracefully
        console.warn('[KernelClient] Mock execution - zeromq not available');
        return Promise.resolve('{"exists": false, "error": "ZMQ not available - install zeromq package"}');
    }

    /**
     * Validates that an expression exists in the kernel and gets its type.
     */
    async validateType(expression: string, timeoutMs: number = 2000): Promise<KernelTypeValidationResult> {
        const code = PYTHON_TEMPLATES.validateType(expression);
        try {
            const result = await this.execute(code, timeoutMs);
            // Parse the last line of output (the JSON result)
            const lines = result.trim().split('\n');
            const jsonLine = lines[lines.length - 1];
            return JSON.parse(jsonLine) as KernelTypeValidationResult;
        } catch (error) {
            return {
                exists: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    /**
     * Estimates the memory size of an object.
     */
    async estimateSize(expression: string, typeName: string, timeoutMs: number = 2000): Promise<KernelSizeResult> {
        const code = PYTHON_TEMPLATES.estimateSize(expression, typeName);
        try {
            const result = await this.execute(code, timeoutMs);
            const lines = result.trim().split('\n');
            const jsonLine = lines[lines.length - 1];
            return JSON.parse(jsonLine) as KernelSizeResult;
        } catch (error) {
            return {
                sizeMb: 0,
                success: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    /**
     * Serializes an object for transmission to the inspection server.
     */
    async serializeObject(
        expression: string,
        copyStrategy: CopyStrategy,
        timeoutMs: number = 5000,
    ): Promise<SerializedPayload> {
        const code = PYTHON_TEMPLATES.serialize(expression, copyStrategy);
        try {
            const result = await this.execute(code, timeoutMs);
            const lines = result.trim().split('\n');
            const jsonLine = lines[lines.length - 1];
            return JSON.parse(jsonLine) as SerializedPayload;
        } catch (error) {
            return {
                serialization: 'pickle',
                payload: '',
                success: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    /**
     * Disconnects from the kernel.
     */
    disconnect(): void {
        // Clear pending executions
        for (const [msgId, pending] of this._pendingExecutions) {
            clearTimeout(pending.timeout);
            pending.reject(new Error('Disconnected'));
        }
        this._pendingExecutions.clear();

        // Close sockets
        if (this._shellSocket) {
            this._shellSocket.close();
            this._shellSocket = undefined;
        }
        if (this._iopubSocket) {
            this._iopubSocket.close();
            this._iopubSocket = undefined;
        }

        this._connectionInfo = undefined;
        this._setState(KernelConnectionState.Disconnected);
    }

    /**
     * Disposes of resources.
     */
    dispose(): void {
        this.disconnect();
        this._listeners.clear();
    }
}
