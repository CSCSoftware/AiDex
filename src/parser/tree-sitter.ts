/**
 * Tree-sitter parser integration for AiDex
 */

import Parser from 'tree-sitter';

// Language grammars
import CSharp from 'tree-sitter-c-sharp';
import TypeScript from 'tree-sitter-typescript';
import Rust from 'tree-sitter-rust';
import Python from 'tree-sitter-python';
import C from 'tree-sitter-c';
import Cpp from 'tree-sitter-cpp';
import Java from 'tree-sitter-java';
import Go from 'tree-sitter-go';
import Php from 'tree-sitter-php';
import Ruby from 'tree-sitter-ruby';

export type SupportedLanguage =
    | 'csharp' | 'typescript' | 'javascript' | 'rust' | 'python'
    | 'c' | 'cpp' | 'java' | 'go' | 'php' | 'ruby';

// Grammar packages export types incompatible with tree-sitter 0.25's Parser.Language interface.
// All grammars work at runtime via NAPI — this is a type declaration mismatch only.
const asLang = (grammar: unknown): Parser.Language => grammar as Parser.Language;

// Maps each supported language (+ tsx/jsx virtual keys) to its tree-sitter grammar
const GRAMMAR_MAP: Record<string, Parser.Language> = {
    csharp: asLang(CSharp),
    typescript: asLang(TypeScript.typescript),
    javascript: asLang(TypeScript.typescript), // TS parser handles JS too
    rust: asLang(Rust),
    python: asLang(Python),
    c: asLang(C),
    cpp: asLang(Cpp),
    java: asLang(Java),
    go: asLang(Go),
    php: asLang(Php.php),
    ruby: asLang(Ruby),
    tsx: asLang(TypeScript.tsx),
    jsx: asLang(TypeScript.tsx), // tsx grammar handles JSX too
};

// File extension to language mapping
const EXTENSION_MAP: Record<string, SupportedLanguage> = {
    '.cs': 'csharp',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.rs': 'rust',
    '.py': 'python',
    '.pyw': 'python',
    '.c': 'c',
    '.h': 'c',
    '.cpp': 'cpp',
    '.cc': 'cpp',
    '.cxx': 'cpp',
    '.hpp': 'cpp',
    '.hxx': 'cpp',
    '.java': 'java',
    '.go': 'go',
    '.php': 'php',
    '.rb': 'ruby',
    '.rake': 'ruby',
};

// Cached parsers per language (includes 'tsx' and 'jsx' as virtual keys)
const parsers: Map<string, Parser> = new Map();

/**
 * Get or create a parser for the given language
 */
export function getParser(language: SupportedLanguage): Parser {
    let parser = parsers.get(language);
    if (parser) {
        return parser;
    }

    parser = new Parser();
    parser.setLanguage(GRAMMAR_MAP[language]);

    parsers.set(language, parser);
    return parser;
}

/**
 * Detect language from file extension
 */
export function detectLanguage(filePath: string): SupportedLanguage | null {
    const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
    return EXTENSION_MAP[ext] ?? null;
}

/**
 * Check if a file extension is supported
 */
export function isSupported(filePath: string): boolean {
    return detectLanguage(filePath) !== null;
}

/**
 * Get all supported file extensions
 */
export function getSupportedExtensions(): string[] {
    return Object.keys(EXTENSION_MAP);
}

// Default buffer size for tree-sitter parser (1 MB)
// Fixes "Invalid argument" error for files > 32KB
// See: https://github.com/tree-sitter/tree-sitter/issues/3473
const PARSE_BUFFER_SIZE = 1024 * 1024;

/**
 * Parse source code and return the syntax tree
 */
export function parse(sourceCode: string, language: SupportedLanguage): Parser.Tree {
    const parser = getParser(language);
    return parser.parse(sourceCode, undefined, { bufferSize: PARSE_BUFFER_SIZE });
}

/**
 * Get the grammar key for a file path (handles tsx/jsx separately)
 */
function getGrammarKey(filePath: string): string | null {
    const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
    if (ext === '.tsx') return 'tsx';
    if (ext === '.jsx') return 'jsx';
    const lang = detectLanguage(filePath);
    return lang;
}

/**
 * Get or create a parser for a specific grammar key (tsx, jsx, or SupportedLanguage)
 */
function getParserForGrammar(grammarKey: string): Parser {
    let parser = parsers.get(grammarKey);
    if (parser) return parser;

    const grammar = GRAMMAR_MAP[grammarKey];
    if (!grammar) {
        throw new Error(`Unsupported grammar: ${grammarKey}`);
    }

    parser = new Parser();
    parser.setLanguage(grammar);
    parsers.set(grammarKey, parser);
    return parser;
}

/**
 * Parse a file's content with auto-detected language
 */
export function parseFile(sourceCode: string, filePath: string): Parser.Tree | null {
    const grammarKey = getGrammarKey(filePath);
    if (!grammarKey) {
        return null;
    }
    const parser = getParserForGrammar(grammarKey);
    return parser.parse(sourceCode, undefined, { bufferSize: PARSE_BUFFER_SIZE });
}
