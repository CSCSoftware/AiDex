/**
 * Kotlin language configuration for AiDex
 *
 * Node types verified against @tree-sitter-grammars/tree-sitter-kotlin@1.1.0
 * by parsing real project files. Kotlin declarations carry their name as a
 * plain `identifier` child (field name `name`), so the default extractor
 * finds them without special handling.
 */

/**
 * Kotlin keywords that should be filtered out during indexing
 */
export const KOTLIN_KEYWORDS = new Set([
    // Hard keywords
    'as', 'break', 'class', 'continue', 'do', 'else', 'false', 'for',
    'fun', 'if', 'in', 'interface', 'is', 'null', 'object', 'package',
    'return', 'super', 'this', 'throw', 'true', 'try', 'typealias',
    'typeof', 'val', 'var', 'when', 'while',

    // Soft keywords / modifiers (context-sensitive, but noise as identifiers)
    'by', 'catch', 'constructor', 'delegate', 'dynamic', 'field', 'file',
    'finally', 'get', 'import', 'init', 'param', 'property', 'receiver',
    'set', 'setparam', 'value', 'where',
    'abstract', 'actual', 'annotation', 'companion', 'const', 'crossinline',
    'data', 'enum', 'expect', 'external', 'final', 'infix', 'inline',
    'inner', 'internal', 'lateinit', 'noinline', 'open', 'operator', 'out',
    'override', 'private', 'protected', 'public', 'reified', 'sealed',
    'suspend', 'tailrec', 'vararg',

    // Common built-in types (usually noise)
    'Any', 'Unit', 'Nothing', 'Boolean', 'Byte', 'Short', 'Int', 'Long',
    'Float', 'Double', 'Char', 'String', 'Array', 'List', 'Map', 'Set',
    'MutableList', 'MutableMap', 'MutableSet',
]);

/**
 * Tree-sitter node types that represent identifiers in Kotlin
 */
export const KOTLIN_IDENTIFIER_NODES = new Set([
    'identifier',
    'simple_identifier',
    'type_identifier',
]);

/**
 * Tree-sitter node types for comments
 */
export const KOTLIN_COMMENT_NODES = new Set([
    'line_comment',
    'multiline_comment',
]);

/**
 * Tree-sitter node types for function declarations.
 * Verified over 41 project files: `function_declaration` is the only named
 * function node. `primary_constructor` carries no own name (= class name),
 * so it is intentionally excluded.
 */
export const KOTLIN_METHOD_NODES = new Set([
    'function_declaration',
]);

/**
 * Tree-sitter node types for type declarations.
 * Enums are `class_declaration` with an `enum` modifier in this grammar —
 * `enum_class_body` is only the body block (no name), so it is excluded.
 */
export const KOTLIN_TYPE_NODES = new Set([
    'class_declaration',
    'object_declaration',
]);

/**
 * Tree-sitter node types for property declarations
 */
export const KOTLIN_PROPERTY_NODES = new Set([
    'property_declaration',
]);

/**
 * Check if a term is a Kotlin keyword
 */
export function isKeyword(term: string): boolean {
    return KOTLIN_KEYWORDS.has(term);
}
