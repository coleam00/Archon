import { isAbsolute, resolve } from 'path';

import { loadMcpConfig } from '../../mcp-config';
import type {
  OmpAuthStorage,
  OmpCodingAgentSdk,
  OmpMcpManager,
  OmpMcpSourceMeta,
} from './sdk-loader';

export interface ResolvedOmpMcp {
  manager: OmpMcpManager;
  customTools: unknown[];
  toolNames: string[];
  serverNames: string[];
  missingVars: string[];
  errors: { path: string; error: string }[];
}

function getToolName(tool: unknown): string | undefined {
  if (typeof tool !== 'object' || tool === null) return undefined;
  const name = (tool as { name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
}

function buildSources(
  serverNames: string[],
  resolvedPath: string
): Record<string, OmpMcpSourceMeta> {
  const sources: Record<string, OmpMcpSourceMeta> = {};
  for (const serverName of serverNames) {
    sources[serverName] = {
      provider: 'archon',
      providerName: 'Archon workflow mcp',
      path: resolvedPath,
      level: 'project',
    };
  }
  return sources;
}

export async function resolveOmpMcp(
  sdk: Pick<OmpCodingAgentSdk, 'MCPManager'>,
  cwd: string,
  mcpPath: string,
  authStorage: OmpAuthStorage
): Promise<ResolvedOmpMcp> {
  const { servers, serverNames, missingVars } = await loadMcpConfig(mcpPath, cwd);
  const manager = new sdk.MCPManager(cwd, null);
  manager.setAuthStorage(authStorage);
  const resolvedPath = isAbsolute(mcpPath) ? mcpPath : resolve(cwd, mcpPath);
  try {
    const result = await manager.connectServers(servers, buildSources(serverNames, resolvedPath));

    const toolNames = result.tools
      .map(getToolName)
      .filter((name): name is string => name !== undefined);
    const errors = [...result.errors].map(([serverName, error]) => ({ path: serverName, error }));

    return {
      manager,
      customTools: result.tools,
      toolNames: [...new Set(toolNames)],
      serverNames,
      missingVars,
      errors,
    };
  } catch (error) {
    await manager.disconnectAll().catch(() => undefined);
    throw error;
  }
}
