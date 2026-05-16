/**
 * Single source of truth for the Claude tool names that agent personas may
 * reference in their `tools:` frontmatter list.
 *
 * Registry validation rejects any tool name not in this set so that misspelt
 * or invented tool names fail at agent-load time rather than at execution time.
 *
 * New Claude tools should be added here as Anthropic ships them.
 */

export const KNOWN_TOOLS: ReadonlySet<string> = new Set([
  // Core read-only tools
  'Read',
  'Glob',
  'Grep',
  'LS',
  // Web
  'WebFetch',
  'WebSearch',
  // Write tools
  'Edit',
  'Write',
  'NotebookEdit',
  // Execution tools
  'Bash',
  // Agent / MCP tools
  'Task',
  'mcp',
  // Browser
  'Browser',
  // Misc
  'TodoWrite',
  'TodoRead',
]);
