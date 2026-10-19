import { mcpServerMap } from '@archon/provider-contract';
import { mcpDeclaration } from '../schemas';
import { readHomeMcpDirectory } from '../compiled-command';
import { resolveMcpPath, missingMcpConfigMessage } from '../mcp-path';
import type { NodeValidation, ResourceValidation } from './context';
import type { ValidationIssue } from './types';

type McpDeclaration = NonNullable<ReturnType<typeof mcpDeclaration>>;

/**
 * An MCP config file exists and is valid JSON, and the provider can load it. An optional
 * declaration is expected to be absent for most users of a portable workflow, so only a
 * file that exists and is broken is an issue; the run records the absence instead.
 */
export async function validateMcp(
  validation: ResourceValidation,
  { node, provider, capabilities }: NodeValidation
): Promise<void> {
  const mcp = 'mcp' in node ? mcpDeclaration(node.mcp) : undefined;
  if (mcp === undefined) return;
  const issue = await mcpConfigIssue(validation.cwd, node, mcp);
  if (issue !== undefined)
    validation.issues.push({ level: 'error', nodeId: node.id, field: 'mcp', ...issue });

  if (capabilities?.mcp === false && !mcp.optional) {
    validation.issues.push({
      level: 'error',
      nodeId: node.id,
      field: 'mcp',
      message: `Provider '${provider}' cannot load MCP servers — the run would fail before any node starts`,
      hint: `Remove the mcp field, declare it optional (mcp: { path: '${mcp.path}', optional: true }), or switch to a provider whose mcp capability is true`,
    });
  }
}

async function mcpConfigIssue(
  cwd: string,
  node: NodeValidation['node'],
  mcp: McpDeclaration
): Promise<Pick<ValidationIssue, 'message' | 'hint'> | undefined> {
  const selected = await resolveMcpPath(mcp.path, cwd, readHomeMcpDirectory(node));
  if (selected.kind === 'missing') {
    if (mcp.optional) return undefined;
    return {
      message: missingMcpConfigMessage(mcp.path, selected.attemptedPaths),
      hint: `Create the file at ${selected.attemptedPaths[0]} with MCP server definitions (JSON format). Example:\n  {"server-name": {"command": "npx", "args": ["-y", "@package/name"], "env": {}}}`,
    };
  }
  if (selected.kind === 'read_error') {
    return {
      message: `Failed to read MCP config file '${selected.path}': ${String(selected.error)}`,
    };
  }
  try {
    const serverMap = mcpServerMap(JSON.parse(selected.content));
    if (serverMap.ok) return undefined;
    return {
      message: `${serverMap.error}: '${mcp.path}'`,
      hint: 'The file should contain a JSON object where each key is a server name, optionally wrapped as { "mcpServers": { ... } }',
    };
  } catch (e) {
    const err = e as Error;
    return {
      message: `MCP config file '${mcp.path}' contains invalid JSON: ${err.message}`,
      hint: 'Fix the JSON syntax in the MCP config file',
    };
  }
}
