/**
 * Type declarations for text file imports using Bun's import attributes
 *
 * These declarations allow TypeScript to understand imports like:
 * import content from './file.md' with { type: 'text' };
 *
 * Bun handles the actual import at compile/runtime.
 *
 * Using wildcard patterns to match all .md and .yaml files.
 */

// Match all .md files (Markdown)
declare module '*.md' {
  const content: string;
  export default content;
}

// Match all .yaml files (YAML)
declare module '*.yaml' {
  const content: string;
  export default content;
}

// Match all .yml files (YAML alternative extension)
declare module '*.yml' {
  const content: string;
  export default content;
}
