import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CLAUDE_CAPABILITIES } from './capabilities';

/**
 * Tool names whose input schema in the SDK's `sdk-tools.d.ts` is named differently
 * from the tool. `null` marks a schema with no fixed tool name (MCP tools are
 * `mcp__<server>__<tool>`, which the validator accepts by prefix).
 */
const SCHEMA_TO_TOOL_NAME: Record<string, string | null> = {
  FileEdit: 'Edit',
  FileRead: 'Read',
  FileWrite: 'Write',
  ListMcpResources: 'ListMcpResourcesTool',
  ReadMcpResource: 'ReadMcpResourceTool',
  ReadMcpResourceDir: 'ReadMcpResourceDirTool',
  Mcp: null,
};

/** Tool names the installed SDK declares input schemas for. */
function sdkDeclaredToolNames(): string[] {
  const sdkDir = dirname(require.resolve('@anthropic-ai/claude-agent-sdk'));
  const source = readFileSync(join(sdkDir, 'sdk-tools.d.ts'), 'utf8');
  const union = /export type ToolInputSchemas =([^;]*);/.exec(source)?.[1];
  if (union === undefined) throw new Error('sdk-tools.d.ts no longer declares ToolInputSchemas');
  return [...union.matchAll(/\|\s*(\w+)Input\b/g)].flatMap(([, schema]) => {
    const name = schema in SCHEMA_TO_TOOL_NAME ? SCHEMA_TO_TOOL_NAME[schema] : schema;
    return name === null ? [] : [name];
  });
}

describe('CLAUDE_CAPABILITIES.knownToolNames', () => {
  test('includes every tool the installed SDK declares', () => {
    const declared = sdkDeclaredToolNames();
    expect(declared.length).toBeGreaterThan(20);
    const known = new Set(CLAUDE_CAPABILITIES.knownToolNames);
    expect(declared.filter(name => !known.has(name))).toEqual([]);
  });
});
