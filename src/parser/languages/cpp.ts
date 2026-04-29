/**
 * C++ language configuration for AiDex
 */

/**
 * C++ keywords that should be filtered out during indexing
 */
export const CPP_KEYWORDS = new Set([
    // Access/Type modifiers
    'public', 'private', 'protected',
    'class', 'struct', 'union', 'enum',
    'namespace', 'using',

    // Type keywords
    'typename',
    'void', 'bool',
    'char', 'char8_t', 'char16_t', 'char32_t', 'wchar_t',
    'short', 'int', 'long',
    'signed', 'unsigned',
    'float', 'double',

    // Modifiers
    'static', 'extern', 'const', 'volatile', 'mutable',
    'constexpr', 'consteval', 'constinit',
    'inline', 'virtual', 'explicit', 'export',
    'friend', 'typedef',

    // Control flow
    'if', 'else', 'switch', 'case', 'default',
    'for', 'while', 'do',
    'break', 'continue', 'return', 'goto',
    'try', 'catch', 'throw',

    // Operators & literals
    'new', 'delete', 'this', 'nullptr',
    'true', 'false',
    'sizeof', 'typeid', 'decltype',
    'static_cast', 'dynamic_cast', 'reinterpret_cast', 'const_cast',
    'operator',

    // C++11 features
    'alignas', 'alignof', 'auto',
    'static_assert', 'noexcept',
    'thread_local',

    // C++17/20 features
    'concept', 'requires',
    'co_await', 'co_return', 'co_yield',

    // Alternative operators (ISO C++)
    'and', 'or', 'not',
    'and_eq', 'or_eq', 'xor', 'xor_eq',
    'bitand', 'bitor', 'compl', 'not_eq',

    // Contextual keywords
    'final', 'override', 'import', 'module',

    // Other
    'asm', 'register',
]);

/**
 * Tree-sitter node types that represent identifiers in C++
 */
export const CPP_IDENTIFIER_NODES = new Set([
    'identifier',
    'type_identifier',
    'field_identifier',
    'namespace_identifier',
]);

/**
 * Tree-sitter node types for comments
 */
export const CPP_COMMENT_NODES = new Set([
    'comment',
]);

/**
 * Tree-sitter node types for function declarations
 */
export const CPP_METHOD_NODES = new Set([
    'function_definition',
    // 'template_function' is intentionally not listed here — it always appears nested
    // inside a `function_definition` (via `qualified_identifier`), so listing it would
    // produce duplicate method entries for template specializations like
    // `template<> void A::foo<int>() {}`.
]);

/**
 * Tree-sitter node types for type declarations
 */
export const CPP_TYPE_NODES = new Set([
    'class_specifier',
    'struct_specifier',
    'union_specifier',
    'enum_specifier',
    'type_definition',
    'template_declaration',
]);

/**
 * Check if a term is a C++ keyword
 */
export function isKeyword(term: string): boolean {
    return CPP_KEYWORDS.has(term);
}
