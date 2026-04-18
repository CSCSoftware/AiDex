/**
 * Language configuration registry
 */

import type { SupportedLanguage } from '../tree-sitter.js';
import * as csharp from './csharp.js';
import * as typescript from './typescript.js';
import * as rust from './rust.js';
import * as python from './python.js';
import * as c from './c.js';
import * as cpp from './cpp.js';
import * as java from './java.js';
import * as go from './go.js';
import * as php from './php.js';
import * as ruby from './ruby.js';
import * as hcl from './hcl.js';

export interface LanguageConfig {
    isKeyword: (term: string) => boolean;
    identifierNodes: Set<string>;
    commentNodes: Set<string>;
    methodNodes: Set<string>;
    typeNodes: Set<string>;
    propertyNodes?: Set<string>;
}

const configs: Record<SupportedLanguage, LanguageConfig> = {
    csharp: {
        isKeyword: csharp.isKeyword,
        identifierNodes: csharp.CSHARP_IDENTIFIER_NODES,
        commentNodes: csharp.CSHARP_COMMENT_NODES,
        methodNodes: csharp.CSHARP_METHOD_NODES,
        typeNodes: csharp.CSHARP_TYPE_NODES,
        propertyNodes: csharp.CSHARP_PROPERTY_NODES,
    },
    typescript: {
        isKeyword: typescript.isKeyword,
        identifierNodes: typescript.TYPESCRIPT_IDENTIFIER_NODES,
        commentNodes: typescript.TYPESCRIPT_COMMENT_NODES,
        methodNodes: typescript.TYPESCRIPT_METHOD_NODES,
        typeNodes: typescript.TYPESCRIPT_TYPE_NODES,
    },
    javascript: {
        // JavaScript uses same config as TypeScript
        isKeyword: typescript.isKeyword,
        identifierNodes: typescript.TYPESCRIPT_IDENTIFIER_NODES,
        commentNodes: typescript.TYPESCRIPT_COMMENT_NODES,
        methodNodes: typescript.TYPESCRIPT_METHOD_NODES,
        typeNodes: typescript.TYPESCRIPT_TYPE_NODES,
    },
    rust: {
        isKeyword: rust.isKeyword,
        identifierNodes: rust.RUST_IDENTIFIER_NODES,
        commentNodes: rust.RUST_COMMENT_NODES,
        methodNodes: rust.RUST_METHOD_NODES,
        typeNodes: rust.RUST_TYPE_NODES,
    },
    python: {
        isKeyword: python.isKeyword,
        identifierNodes: python.PYTHON_IDENTIFIER_NODES,
        commentNodes: python.PYTHON_COMMENT_NODES,
        methodNodes: python.PYTHON_METHOD_NODES,
        typeNodes: python.PYTHON_TYPE_NODES,
    },
    c: {
        isKeyword: c.isKeyword,
        identifierNodes: c.C_IDENTIFIER_NODES,
        commentNodes: c.C_COMMENT_NODES,
        methodNodes: c.C_METHOD_NODES,
        typeNodes: c.C_TYPE_NODES,
    },
    cpp: {
        isKeyword: cpp.isKeyword,
        identifierNodes: cpp.CPP_IDENTIFIER_NODES,
        commentNodes: cpp.CPP_COMMENT_NODES,
        methodNodes: cpp.CPP_METHOD_NODES,
        typeNodes: cpp.CPP_TYPE_NODES,
    },
    java: {
        isKeyword: java.isKeyword,
        identifierNodes: java.JAVA_IDENTIFIER_NODES,
        commentNodes: java.JAVA_COMMENT_NODES,
        methodNodes: java.JAVA_METHOD_NODES,
        typeNodes: java.JAVA_TYPE_NODES,
    },
    go: {
        isKeyword: go.isKeyword,
        identifierNodes: go.GO_IDENTIFIER_NODES,
        commentNodes: go.GO_COMMENT_NODES,
        methodNodes: go.GO_METHOD_NODES,
        typeNodes: go.GO_TYPE_NODES,
    },
    php: {
        isKeyword: php.isKeyword,
        identifierNodes: php.PHP_IDENTIFIER_NODES,
        commentNodes: php.PHP_COMMENT_NODES,
        methodNodes: php.PHP_METHOD_NODES,
        typeNodes: php.PHP_TYPE_NODES,
    },
    ruby: {
        isKeyword: ruby.isKeyword,
        identifierNodes: ruby.RUBY_IDENTIFIER_NODES,
        commentNodes: ruby.RUBY_COMMENT_NODES,
        methodNodes: ruby.RUBY_METHOD_NODES,
        typeNodes: ruby.RUBY_TYPE_NODES,
    },
    hcl: {
        isKeyword: hcl.isKeyword,
        identifierNodes: hcl.HCL_IDENTIFIER_NODES,
        commentNodes: hcl.HCL_COMMENT_NODES,
        methodNodes: hcl.HCL_METHOD_NODES,
        typeNodes: hcl.HCL_TYPE_NODES,
        propertyNodes: hcl.HCL_PROPERTY_NODES,
    },
};

/**
 * Get language configuration
 */
export function getLanguageConfig(language: SupportedLanguage): LanguageConfig {
    return configs[language];
}

/**
 * Check if a term is a keyword for the given language
 */
export function isKeyword(term: string, language: SupportedLanguage): boolean {
    return configs[language].isKeyword(term);
}
