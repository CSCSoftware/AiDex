/**
 * Swift language configuration for AiDex
 *
 * Node types verified against tree-sitter-swift@0.7.1 by parsing 20 real
 * project files. Two grammar quirks matter:
 *  - All nominal types (class / struct / enum / protocol / extension) parse as
 *    `class_declaration`, distinguished only by a `declaration_kind` child.
 *    So `class_declaration` alone covers every type declaration.
 *  - Function names are `simple_identifier` (not `identifier`), and
 *    init/deinit names are anonymous `init`/`deinit` tokens. The extractor
 *    therefore relies on `childForFieldName('name')` to get the name.
 */

/**
 * Swift keywords that should be filtered out during indexing
 */
export const SWIFT_KEYWORDS = new Set([
    // Declarations
    'associatedtype', 'class', 'deinit', 'enum', 'extension', 'fileprivate',
    'func', 'import', 'init', 'inout', 'internal', 'let', 'open', 'operator',
    'private', 'protocol', 'public', 'rethrows', 'static', 'struct',
    'subscript', 'typealias', 'var',

    // Statements
    'break', 'case', 'continue', 'default', 'defer', 'do', 'else', 'fallthrough',
    'for', 'guard', 'if', 'in', 'repeat', 'return', 'switch', 'where', 'while',

    // Expressions and types
    'as', 'catch', 'false', 'is', 'nil', 'self', 'Self', 'super', 'throw',
    'throws', 'true', 'try', 'async', 'await', 'some', 'any',

    // Modifiers / contextual
    'convenience', 'dynamic', 'final', 'lazy', 'mutating', 'nonmutating',
    'optional', 'override', 'required', 'weak', 'unowned', 'indirect',
    'get', 'set', 'willSet', 'didSet',

    // Common built-in types (usually noise)
    'Int', 'UInt', 'Float', 'Double', 'Bool', 'String', 'Character', 'Void',
    'Array', 'Dictionary', 'Set', 'Optional', 'Any', 'AnyObject',
]);

/**
 * Tree-sitter node types that represent identifiers in Swift
 */
export const SWIFT_IDENTIFIER_NODES = new Set([
    'simple_identifier',
    'type_identifier',
]);

/**
 * Tree-sitter node types for comments
 */
export const SWIFT_COMMENT_NODES = new Set([
    'comment',
    'multiline_comment',
]);

/**
 * Tree-sitter node types for function declarations.
 * Verified over 20 files: functions, plus init/deinit which the extractor
 * names via the `name` field.
 */
export const SWIFT_METHOD_NODES = new Set([
    'function_declaration',
    'init_declaration',
    'deinit_declaration',
]);

/**
 * Tree-sitter node types for type declarations.
 * `class_declaration` covers class/struct/enum/protocol/extension in this
 * grammar (see header note).
 */
export const SWIFT_TYPE_NODES = new Set([
    'class_declaration',
    'protocol_declaration',
]);

/**
 * Tree-sitter node types for property declarations
 */
export const SWIFT_PROPERTY_NODES = new Set([
    'property_declaration',
]);

/**
 * Check if a term is a Swift keyword
 */
export function isKeyword(term: string): boolean {
    return SWIFT_KEYWORDS.has(term);
}
