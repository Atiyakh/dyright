/*
 * runtimeAwareHoverProvider.ts
 * Copyright (c) 2026
 * Licensed under the MIT license.
 *
 * Extended hover provider that integrates runtime inspection
 * with static analysis for notebook environments.
 */

import { CancellationToken, Hover, MarkupKind } from 'vscode-languageserver';

import * as ParseTreeUtils from '../analyzer/parseTreeUtils';
import { TypeEvaluator } from '../analyzer/typeEvaluatorTypes';
import { Type, TypeCategory, isClassInstance } from '../analyzer/types';
import { ProgramView } from '../common/extensibility';
import { convertOffsetToPosition, convertPositionToOffset } from '../common/positionUtils';
import { Position, TextRange } from '../common/textRange';
import { Uri } from '../common/uri/uri';
import { NameNode, ParseNodeType } from '../parser/parseNodes';
import { ParseFileResults } from '../parser/parser';
import { InspectionFailureReason, RuntimeInspectionResult, RuntimeInspectionService } from '../runtimeInspection';
import { HoverProvider } from './hoverProvider';
import { getTypeForToolTip } from './tooltipUtils';

/**
 * Options for the runtime-aware hover provider.
 */
export interface RuntimeAwareHoverOptions {
    /** Enable runtime inspection */
    enableRuntimeInspection: boolean;
    /** Maximum time to wait for runtime inspection (ms) */
    runtimeInspectionTimeoutMs: number;
    /** Show timing information in debug mode */
    showTimingInfo: boolean;
}

const DEFAULT_OPTIONS: RuntimeAwareHoverOptions = {
    enableRuntimeInspection: true,
    runtimeInspectionTimeoutMs: 3000,
    showTimingInfo: false,
};

/**
 * Extended hover provider with runtime inspection capabilities.
 *
 * This provider:
 * 1. Performs standard static analysis (always)
 * 2. Optionally augments with runtime inspection for configured types
 * 3. Composes a combined hover result
 */
export class RuntimeAwareHoverProvider {
    private readonly _staticProvider: HoverProvider;
    private readonly _parseResults: ParseFileResults | undefined;
    private readonly _options: RuntimeAwareHoverOptions;

    constructor(
        private readonly _program: ProgramView,
        private readonly _fileUri: Uri,
        private readonly _position: Position,
        private readonly _format: MarkupKind,
        private readonly _token: CancellationToken,
        private readonly _runtimeService: RuntimeInspectionService | undefined,
        options?: Partial<RuntimeAwareHoverOptions>,
    ) {
        this._staticProvider = new HoverProvider(_program, _fileUri, _position, _format, _token);
        this._parseResults = this._program.getParseResults(this._fileUri);
        this._options = { ...DEFAULT_OPTIONS, ...options };
    }

    /**
     * Gets hover information, potentially augmented with runtime data.
     */
    async getHover(): Promise<Hover | null> {
        // Always get static hover first
        const staticHover = this._staticProvider.getHover();

        // If runtime inspection is disabled or no service, return static only
        if (!this._options.enableRuntimeInspection || !this._runtimeService || !this._runtimeService.isAvailable()) {
            return staticHover;
        }

        // Get the expression and type info for potential runtime inspection
        const expressionInfo = this._getExpressionInfo();
        if (!expressionInfo) {
            return staticHover;
        }

        const { expression, staticType, node } = expressionInfo;

        // Check if this type is configured for runtime inspection
        if (!this._runtimeService.hasTypeConfig(staticType)) {
            return staticHover;
        }

        // Perform runtime inspection
        try {
            const runtimeResult = await Promise.race([
                this._runtimeService.inspectForHover(expression, staticType),
                this._createTimeoutPromise(),
            ]);

            // Compose combined hover
            return this._composeHover(staticHover, runtimeResult, node);
        } catch (error) {
            // On any error, fall back to static hover
            console.error('[RuntimeAwareHoverProvider] Runtime inspection error:', error);
            return staticHover;
        }
    }

    /**
     * Gets expression information from the hovered position.
     */
    private _getExpressionInfo(): {
        expression: string;
        staticType: string;
        node: NameNode;
    } | null {
        if (!this._parseResults) {
            return null;
        }

        const offset = convertPositionToOffset(this._position, this._parseResults.tokenizerOutput.lines);
        if (offset === undefined) {
            return null;
        }

        const node = ParseTreeUtils.findNodeByOffset(this._parseResults.parserOutput.parseTree, offset);
        if (!node || node.nodeType !== ParseNodeType.Name) {
            return null;
        }

        const evaluator = this._program.evaluator;
        if (!evaluator) {
            return null;
        }

        // Get the type
        const type = getTypeForToolTip(evaluator, node);
        const staticType = this._getFullyQualifiedTypeName(type, evaluator);

        if (!staticType) {
            return null;
        }

        // Get the expression text
        // For simple names, just use the name
        // For member access, build the full expression
        const expression = this._buildExpression(node);

        return {
            expression,
            staticType,
            node,
        };
    }

    /**
     * Builds the full expression string for a node.
     */
    private _buildExpression(node: NameNode): string {
        const parts: string[] = [node.d.value];
        let current = node.parent;

        while (current) {
            if (current.nodeType === ParseNodeType.MemberAccess) {
                const memberNode = current;
                if (memberNode.d.leftExpr.nodeType === ParseNodeType.Name) {
                    parts.unshift(memberNode.d.leftExpr.d.value);
                }
            } else if (current.nodeType === ParseNodeType.Index) {
                // Handle indexing like df["column"]
                break;
            }
            current = current.parent;
        }

        return parts.join('.');
    }

    /**
     * Gets the fully qualified type name.
     */
    private _getFullyQualifiedTypeName(type: Type, evaluator: TypeEvaluator): string | null {
        if (type.category === TypeCategory.Unknown || type.category === TypeCategory.Any) {
            return null;
        }

        if (isClassInstance(type)) {
            const classType = type;
            const moduleName = classType.shared.moduleName || '';
            const className = classType.shared.name;
            return moduleName ? `${moduleName}.${className}` : className;
        }

        // For other types, use the printed representation
        const printed = evaluator.printType(type);
        return printed;
    }

    /**
     * Creates a timeout promise.
     */
    private _createTimeoutPromise(): Promise<RuntimeInspectionResult> {
        return new Promise((_, reject) => {
            setTimeout(() => {
                reject(new Error('Runtime inspection timeout'));
            }, this._options.runtimeInspectionTimeoutMs);
        });
    }

    /**
     * Composes the final hover from static and runtime results.
     */
    private _composeHover(
        staticHover: Hover | null,
        runtimeResult: RuntimeInspectionResult,
        node: NameNode,
    ): Hover | null {
        if (!this._parseResults) {
            return staticHover;
        }

        const parts: string[] = [];

        // Static type section
        if (staticHover?.contents) {
            const staticContent =
                typeof staticHover.contents === 'string'
                    ? staticHover.contents
                    : 'value' in staticHover.contents
                      ? staticHover.contents.value
                      : '';
            if (staticContent) {
                parts.push(staticContent);
            }
        }

        // Runtime inspection section
        if (runtimeResult.success && runtimeResult.dynamicResult) {
            parts.push('');
            parts.push('---');
            parts.push('');
            parts.push('**Runtime Inspection:**');
            parts.push('```');
            parts.push(runtimeResult.dynamicResult);
            parts.push('```');
        } else if (!runtimeResult.success && runtimeResult.failureReason) {
            // Add a note about why runtime inspection failed
            const failureNote = this._getFailureNote(runtimeResult.failureReason);
            if (failureNote) {
                parts.push('');
                parts.push(`*${failureNote}*`);
            }
        }

        // Notes/warnings
        if (runtimeResult.notes && runtimeResult.notes.length > 0) {
            parts.push('');
            runtimeResult.notes.forEach((note) => {
                parts.push(`> ⚠️ ${note}`);
            });
        }

        // Timing info (debug mode)
        if (this._options.showTimingInfo && runtimeResult.timing) {
            parts.push('');
            parts.push(`*Inspection: ${runtimeResult.timing.totalMs}ms*`);
        }

        const markupString = parts.join('\n');

        return {
            contents: {
                kind: this._format,
                value: markupString,
            },
            range: staticHover?.range ?? {
                start: convertOffsetToPosition(node.start, this._parseResults.tokenizerOutput.lines),
                end: convertOffsetToPosition(TextRange.getEnd(node), this._parseResults.tokenizerOutput.lines),
            },
        };
    }

    /**
     * Gets a user-friendly note for a failure reason.
     */
    private _getFailureNote(reason: InspectionFailureReason): string | null {
        switch (reason) {
            case InspectionFailureReason.KernelNotConnected:
                return 'Kernel not connected for runtime inspection';
            case InspectionFailureReason.ObjectNotFound:
                return 'Variable not found in kernel (may not be defined yet)';
            case InspectionFailureReason.SizeExceeded:
                return 'Object too large for runtime inspection';
            case InspectionFailureReason.InspectionTimeout:
                return 'Runtime inspection timed out';
            case InspectionFailureReason.TypeNotConfigured:
                return null; // Don't show note for unconfigured types
            default:
                return null;
        }
    }
}

/**
 * Factory function to create a runtime-aware hover provider.
 */
export function createRuntimeAwareHoverProvider(
    program: ProgramView,
    fileUri: Uri,
    position: Position,
    format: MarkupKind,
    token: CancellationToken,
    runtimeService?: RuntimeInspectionService,
    options?: Partial<RuntimeAwareHoverOptions>,
): RuntimeAwareHoverProvider {
    return new RuntimeAwareHoverProvider(program, fileUri, position, format, token, runtimeService, options);
}
