/**
 * HCL (HashiCorp Configuration Language) / Terraform configuration for AiDex
 */

/**
 * HCL keywords and common built-ins that should be filtered out during indexing
 */
export const HCL_KEYWORDS = new Set([
    // Block types & reference prefixes (Terraform)
    'resource', 'data', 'module', 'variable', 'output', 'locals',
    'provider', 'terraform', 'backend', 'provisioner', 'connection',
    'lifecycle', 'moved', 'import', 'check', 'removed',
    'self', 'local', 'var', 'path', 'root',

    // Meta-arguments
    'count', 'for_each', 'depends_on', 'providers', 'source', 'version',

    // Lifecycle arguments
    'create_before_destroy', 'prevent_destroy', 'ignore_changes',
    'replace_triggered_by', 'precondition', 'postcondition',

    // Type constraints
    'string', 'number', 'bool', 'list', 'map', 'set', 'object', 'tuple',
    'any', 'optional', 'type',

    // Literals & values
    'true', 'false', 'null',

    // Expression keywords
    'for', 'in', 'if', 'else', 'each',

    // Common attribute names (noise)
    'default', 'description', 'sensitive', 'validation',
    'nullable', 'value', 'condition', 'error_message',

    // Common built-in functions (high frequency, low signal)
    'abs', 'ceil', 'floor', 'log', 'max', 'min', 'parseint', 'pow', 'signum',
    'chomp', 'format', 'formatlist', 'indent', 'join', 'lower', 'regex', 'regexall',
    'replace', 'split', 'strrev', 'substr', 'title', 'trim', 'trimprefix',
    'trimsuffix', 'trimspace', 'upper',
    'chunklist', 'coalesce', 'coalescelist', 'compact', 'concat', 'contains',
    'distinct', 'element', 'flatten', 'index', 'keys', 'length', 'lookup',
    'matchkeys', 'merge', 'range', 'reverse', 'setintersection', 'setproduct',
    'setsubtract', 'setunion', 'slice', 'sort', 'sum', 'toset', 'transpose', 'values',
    'zipmap',
    'base64decode', 'base64encode', 'base64gzip', 'csvdecode', 'jsondecode',
    'jsonencode', 'textdecodebase64', 'textencodebase64', 'urlencode', 'yamldecode',
    'yamlencode',
    'abspath', 'dirname', 'pathexpand', 'basename', 'file', 'fileexists',
    'fileset', 'filebase64', 'templatefile',
    'formatdate', 'timeadd', 'timestamp',
    'base64sha256', 'base64sha512', 'bcrypt', 'filebase64sha256', 'filebase64sha512',
    'filemd5', 'filesha1', 'filesha256', 'filesha512', 'md5', 'rsadecrypt',
    'sha1', 'sha256', 'sha512', 'uuid', 'uuidv5',
    'cidrhost', 'cidrnetmask', 'cidrsubnet', 'cidrsubnets',
    'can', 'nonsensitive', 'tobool', 'tolist', 'tomap', 'tonumber',
    'tostring', 'try',
]);

/**
 * Tree-sitter node types that represent identifiers in HCL
 */
export const HCL_IDENTIFIER_NODES = new Set([
    'identifier',
    'variable_expr',
]);

/**
 * Tree-sitter node types for comments (# line, // line, and block comments)
 */
export const HCL_COMMENT_NODES = new Set([
    'comment',
]);

/**
 * Tree-sitter node types for function calls — treated as "methods" for indexing
 */
export const HCL_METHOD_NODES = new Set([
    'function_call',
]);

/**
 * Tree-sitter node types for block declarations — treated as "types" for indexing
 * (resource, variable, output, module, data, locals, provider, terraform, etc.)
 */
export const HCL_TYPE_NODES = new Set([
    'block',
]);

/**
 * Tree-sitter node types for attribute declarations (key = value assignments)
 */
export const HCL_PROPERTY_NODES = new Set([
    'attribute',
]);

/**
 * Check if a term is an HCL keyword
 */
export function isKeyword(term: string): boolean {
    return HCL_KEYWORDS.has(term);
}
