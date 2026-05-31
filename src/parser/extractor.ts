/**
 * Code extractor - extracts items, lines, and metadata from source files
 */

import type Parser from 'tree-sitter';
import { detectLanguage, parseFile, type SupportedLanguage } from './tree-sitter.js';
import { getLanguageConfig } from './languages/index.js';
import type { LineRow } from '../db/queries.js';

// ============================================================
// Types
// ============================================================

export interface ExtractedItem {
    term: string;
    lineNumber: number;
    lineType: LineRow['line_type'];
}

export interface ExtractedLine {
    lineNumber: number;
    lineType: LineRow['line_type'];
}

export interface ExtractedMethod {
    name: string;
    prototype: string;
    lineNumber: number;
    visibility: string | null;
    isStatic: boolean;
    isAsync: boolean;
    bodyText: string | null;
    bodyLines: number | null;
    bodyTruncated: boolean;
}

// Truncation settings for stored method bodies (chars).
// Bodies larger than MAX_BODY_CHARS are truncated to head + tail.
export const MAX_BODY_CHARS = 8000;
export const TRUNC_HEAD_CHARS = 4000;
export const TRUNC_TAIL_CHARS = 1000;

export interface ExtractedType {
    name: string;
    kind: 'class' | 'struct' | 'interface' | 'enum' | 'type';
    lineNumber: number;
}

export interface ExtractionResult {
    language: SupportedLanguage;
    items: ExtractedItem[];
    lines: ExtractedLine[];
    methods: ExtractedMethod[];
    types: ExtractedType[];
    headerComments: string[];
}

// ============================================================
// Main extraction function
// ============================================================

/**
 * Extract all indexable information from source code
 */
export function extract(sourceCode: string, filePath: string): ExtractionResult | null {
    const detectedLanguage = detectLanguage(filePath);
    if (!detectedLanguage) {
        return null;
    }
    const language: SupportedLanguage = detectedLanguage;

    const tree = parseFile(sourceCode, filePath);
    if (!tree) {
        return null;
    }

    const config = getLanguageConfig(language);
    const sourceLines = sourceCode.split('\n');

    const items: ExtractedItem[] = [];
    const linesMap = new Map<number, LineRow['line_type']>();
    const methods: ExtractedMethod[] = [];
    const types: ExtractedType[] = [];
    const headerComments: string[] = [];

    // Track if we've seen non-comment code (for header comments)
    let seenCode = false;

    /**
     * Recursively visit all nodes in the tree
     */
    function visit(node: Parser.SyntaxNode): void {
        const lineNumber = node.startPosition.row + 1; // 1-based

        // Check for comments
        // Fix 1.8: Python docstrings (expression_statement containing only a string child)
        const isDocstring = language === 'python'
            && node.type === 'expression_statement'
            && node.childCount === 1
            && node.children[0].type === 'string';
        if (config.commentNodes.has(node.type) || isDocstring) {
            if (!seenCode) {
                // This is a header comment
                headerComments.push(extractCommentText(node.text));
            }
            setLineType(lineNumber, 'comment');
            extractIdentifiersFromComment(node.text, lineNumber, items, config.isKeyword);
            return; // Don't recurse into comments/docstrings
        }

        // Check for type declarations (class, struct, interface, etc.)
        if (config.typeNodes.has(node.type)) {
            seenCode = true;
            const typeInfo = extractTypeInfo(node, language);
            if (typeInfo) {
                types.push(typeInfo);
                setLineType(lineNumber, 'struct');

                // HCL: block labels are in a composed name (e.g. "resource.aws_instance.web").
                // Index each label part as an item so `aidex_query` finds the declaration
                // even when the label is only referenced here (e.g. a never-used module).
                // Skip the first part (block type keyword like "resource"); index the rest
                // unconditionally — labels like "default" or "root" are user-chosen names
                // that happen to collide with HCL_KEYWORDS, but are meaningful here.
                if (language === 'hcl' && node.type === 'block') {
                    const parts = typeInfo.name.split('.');
                    for (let i = 1; i < parts.length; i++) {
                        if (parts[i].length >= 2) {
                            items.push({ term: parts[i], lineNumber, lineType: 'struct' });
                        }
                    }
                }
            }
        }

        // Check for method declarations
        if (config.methodNodes.has(node.type)) {
            seenCode = true;
            const methodInfo = extractMethodInfo(node, language, sourceLines);
            if (methodInfo) {
                methods.push(methodInfo);
                // HCL function_call is a usage (inside an attribute expression), not a definition.
                // Don't overwrite the enclosing attribute's 'property' line type.
                if (!(language === 'hcl' && node.type === 'function_call')) {
                    setLineType(lineNumber, 'method');
                }
            }
        }

        // Check for property declarations
        if (config.propertyNodes?.has(node.type)) {
            seenCode = true;
            setLineType(lineNumber, 'property');
        }

        // Check for identifiers
        if (config.identifierNodes.has(node.type)) {
            seenCode = true;
            const term = node.text;

            // Filter out keywords and very short terms
            if (term.length >= 2 && !config.isKeyword(term)) {
                items.push({
                    term,
                    lineNumber,
                    lineType: linesMap.get(lineNumber) ?? 'code',
                });
                setLineType(lineNumber, linesMap.get(lineNumber) ?? 'code');
            }
        }

        // Recurse into children
        for (const child of node.children) {
            visit(child);
        }
    }

    /**
     * Set line type (doesn't overwrite more specific types)
     */
    function setLineType(lineNumber: number, type: LineRow['line_type']): void {
        const existing = linesMap.get(lineNumber);
        if (!existing || shouldUpgrade(existing, type)) {
            linesMap.set(lineNumber, type);
        }
    }

    // Start traversal
    visit(tree.rootNode);

    // Convert lines map to array
    const lines: ExtractedLine[] = Array.from(linesMap.entries())
        .map(([lineNumber, lineType]) => ({ lineNumber, lineType }))
        .sort((a, b) => a.lineNumber - b.lineNumber);

    // Update item line types from final linesMap
    for (const item of items) {
        item.lineType = linesMap.get(item.lineNumber) ?? 'code';
    }

    return {
        language,
        items,
        lines,
        methods,
        types,
        headerComments,
    };
}

// ============================================================
// Helper functions
// ============================================================

/**
 * Priority order for line types (higher = more specific)
 */
const LINE_TYPE_PRIORITY: Record<LineRow['line_type'], number> = {
    code: 0,
    string: 1,
    comment: 2,
    property: 3,
    method: 4,
    struct: 5,
};

/**
 * Check if we should upgrade from one type to another
 */
function shouldUpgrade(existing: LineRow['line_type'], newType: LineRow['line_type']): boolean {
    return LINE_TYPE_PRIORITY[newType] > LINE_TYPE_PRIORITY[existing];
}

/**
 * Extract plain text from a comment (remove comment markers)
 */
function extractCommentText(commentText: string): string {
    return commentText
        .replace(/^\/\/\s*/gm, '')          // Remove //
        .replace(/^\/\*+\s*/g, '')           // Remove /*
        .replace(/\s*\*+\/$/g, '')           // Remove */
        .replace(/^\s*\*\s?/gm, '')          // Remove * at start of lines
        .replace(/^#+\s*/gm, '')             // Remove # (Python)
        .trim();
}

/**
 * Extract identifiers from comment text
 */
function extractIdentifiersFromComment(
    commentText: string,
    lineNumber: number,
    items: ExtractedItem[],
    isKeyword: (term: string) => boolean
): void {
    // Extract words that look like identifiers (CamelCase, snake_case, etc.)
    const identifierPattern = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
    const matches = commentText.match(identifierPattern) ?? [];

    for (const term of matches) {
        if (term.length >= 3 && !isKeyword(term)) {
            items.push({
                term,
                lineNumber,
                lineType: 'comment',
            });
        }
    }
}

/**
 * Extract type information from a type declaration node
 */
function extractTypeInfo(node: Parser.SyntaxNode, language: SupportedLanguage): ExtractedType | null {
    // HCL blocks: compose name from block type keyword + string labels
    // e.g. `resource "aws_instance" "web"` → `resource.aws_instance.web`
    if (language === 'hcl' && node.type === 'block') {
        const parts: string[] = [];
        for (const child of node.children) {
            if (child.type === 'identifier') {
                parts.push(child.text);
            } else if (child.type === 'string_lit') {
                // Grammar guarantees string_lit for block labels is wrapped in double quotes
                parts.push(child.text.slice(1, -1));
            } else if (child.type === 'block_start') {
                break;
            }
        }
        if (parts.length > 0) {
            return {
                name: parts.join('.'),
                kind: 'type',
                lineNumber: node.startPosition.row + 1,
            };
        }
    }

    // Find the name child
    const nameNode = node.children.find(c =>
        c.type === 'identifier' || c.type === 'type_identifier' || c.type === 'name'
    );

    if (!nameNode) {
        return null;
    }

    // Determine kind from node type
    let kind: ExtractedType['kind'] = 'class';
    const nodeType = node.type.toLowerCase();

    if (nodeType.includes('struct')) kind = 'struct';
    else if (nodeType.includes('interface')) kind = 'interface';
    else if (nodeType.includes('enum')) kind = 'enum';
    else if (nodeType.includes('type_alias')) kind = 'type';

    return {
        name: nameNode.text,
        kind,
        lineNumber: node.startPosition.row + 1,
    };
}

/**
 * Find the function name inside a C/C++ function_definition node.
 *
 * The tree-sitter-c grammar nests the name under a declarator chain:
 *   function_definition
 *     → (pointer_declarator)*        // one level per `*` in the return type
 *       → function_declarator
 *         → identifier               // the name we want
 *
 * For C++ the chain may also include reference_declarator (`&`), and the leaf
 * may be a field_identifier / qualified_identifier (e.g. `Class::method`).
 * Returns the bare name, or null if no declarator is found.
 */
function findCFunctionName(node: Parser.SyntaxNode): string | null {
    // Descend through wrapping declarators to reach the function_declarator.
    let cursor: Parser.SyntaxNode | null = node.childForFieldName('declarator');
    while (cursor) {
        if (cursor.type === 'function_declarator') {
            const decl = cursor.childForFieldName('declarator');
            if (decl) {
                // decl is identifier / field_identifier / qualified_identifier / destructor_name.
                return decl.text;
            }
            return null;
        }
        // pointer_declarator, reference_declarator, parenthesized_declarator all
        // hold the next declarator in their own `declarator` field.
        cursor = cursor.childForFieldName('declarator');
    }
    return null;
}

/**
 * Extract method information from a method declaration node
 */
function extractMethodInfo(
    node: Parser.SyntaxNode,
    language: SupportedLanguage,
    sourceLines: string[]
): ExtractedMethod | null {
    // Find method name
    let name: string | null = null;
    let visibility: string | null = null;
    let isStatic = false;
    let isAsync = false;

    // Helper to check modifier text
    function checkModifier(text: string): void {
        const lower = text.toLowerCase();
        if (lower === 'public' || lower === 'private' || lower === 'protected' || lower === 'internal') {
            visibility = lower;
        }
        if (lower === 'static') isStatic = true;
        if (lower === 'async') isAsync = true;
    }

    // C/C++: the function name is never a direct identifier child of
    // function_definition. It lives inside a function_declarator, which may be
    // wrapped in any number of pointer_declarator nodes (e.g. `uint8_t *slot_at(...)`)
    // or reference_declarator (C++). Walk down to find it.
    if ((language === 'c' || language === 'cpp') && node.type === 'function_definition') {
        name = findCFunctionName(node);
    }

    for (const child of node.children) {
        if (child.type === 'identifier' || child.type === 'property_identifier' || child.type === 'name') {
            if (!name) name = child.text;
        }

        // Fix 3.12: Handle modifier containers (C# modifier_list, etc.)
        if (child.type === 'modifiers' || child.type === 'modifier_list' || child.type === 'modifier') {
            // Recurse into modifier container to find individual modifiers
            for (const mod of child.children) {
                checkModifier(mod.text);
            }
            // Also check the container itself if it's a single modifier
            checkModifier(child.text);
        } else {
            // Check modifiers directly on child
            checkModifier(child.text);
        }
    }

    // Fix 1.7: Arrow functions / function expressions get name from parent variable_declarator
    if (!name && (node.type === 'arrow_function' || node.type === 'function_expression')) {
        const parent = node.parent;
        if (parent && parent.type === 'variable_declarator') {
            const nameNode = parent.children.find(c => c.type === 'identifier');
            if (nameNode) {
                name = nameNode.text;
            }
        }
    }

    if (!name) {
        return null;
    }

    // Extract prototype (first line of method, cleaned up)
    const startLine = node.startPosition.row;
    const endLine = Math.min(startLine + 5, sourceLines.length - 1); // Max 6 lines for prototype

    let prototype = '';
    for (let i = startLine; i <= endLine; i++) {
        const line = sourceLines[i]?.trim() ?? '';
        prototype += (prototype ? ' ' : '') + line;

        // Stop at opening brace or arrow
        if (line.includes('{') || line.includes('=>')) {
            prototype = prototype.replace(/\s*\{.*$/, '').replace(/\s*=>.*$/, '').trim();
            break;
        }
    }

    // Clean up prototype
    prototype = prototype
        .replace(/\s+/g, ' ')
        .replace(/\s*,\s*/g, ', ')
        .trim();

    // Body extraction: full method text from start line to end line.
    // Used by embeddings for re-indexing on model change and snippet display.
    const bodyStartRow = node.startPosition.row;
    const bodyEndRow = Math.min(node.endPosition.row, sourceLines.length - 1);
    const bodyLineCount = bodyEndRow - bodyStartRow + 1;
    const rawBody = sourceLines.slice(bodyStartRow, bodyEndRow + 1).join('\n');

    let bodyText: string;
    let bodyTruncated = false;
    if (rawBody.length > MAX_BODY_CHARS) {
        bodyTruncated = true;
        const head = rawBody.slice(0, TRUNC_HEAD_CHARS);
        const tail = rawBody.slice(-TRUNC_TAIL_CHARS);
        const skipped = rawBody.length - TRUNC_HEAD_CHARS - TRUNC_TAIL_CHARS;
        bodyText = `${head}\n... [truncated, ${skipped} chars omitted] ...\n${tail}`;
    } else {
        bodyText = rawBody;
    }

    return {
        name,
        prototype,
        lineNumber: node.startPosition.row + 1,
        visibility,
        isStatic,
        isAsync,
        bodyText,
        bodyLines: bodyLineCount,
        bodyTruncated,
    };
}

// ============================================================
// Exports
// ============================================================

export { detectLanguage, isSupported, getSupportedExtensions } from './tree-sitter.js';
