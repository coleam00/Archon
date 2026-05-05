import { createLogger } from '@archon/paths';
import { readFile } from 'fs/promises';
import { isAbsolute, resolve } from 'path';

export interface LoadedMcpConfig {
  servers: Record<string, unknown>;
  serverNames: string[];
  missingVars: string[];
}

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.mcp-config');
  return cachedLog;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Expand $VAR_NAME references in string-valued records from process.env.
 */
function expandEnvVarsInRecord(
  record: Record<string, unknown>,
  missingVars: string[]
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(record)) {
    if (typeof val !== 'string') {
      getLog().warn({ key, valueType: typeof val }, 'mcp.env_value_coerced_to_string');
      result[key] = String(val);
      continue;
    }
    result[key] = val.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, varName: string) => {
      const envVal = process.env[varName];
      if (envVal === undefined) {
        missingVars.push(varName);
      }
      return envVal ?? '';
    });
  }
  return result;
}

function expandEnvVars(config: Record<string, unknown>, mcpPath: string): LoadedMcpConfig {
  const servers: Record<string, unknown> = {};
  const missingVars: string[] = [];
  for (const [serverName, serverConfig] of Object.entries(config)) {
    if (typeof serverConfig !== 'object' || serverConfig === null || Array.isArray(serverConfig)) {
      throw new Error(`MCP server config must be a JSON object: ${serverName} in ${mcpPath}`);
    }
    const server = { ...(serverConfig as Record<string, unknown>) };
    if (server.env !== undefined) {
      if (!isRecord(server.env)) {
        throw new Error(`MCP server env must be a JSON object: ${serverName} in ${mcpPath}`);
      }
      server.env = expandEnvVarsInRecord(server.env, missingVars);
    }
    if (server.headers !== undefined) {
      if (!isRecord(server.headers)) {
        throw new Error(`MCP server headers must be a JSON object: ${serverName} in ${mcpPath}`);
      }
      server.headers = expandEnvVarsInRecord(server.headers, missingVars);
    }
    servers[serverName] = server;
  }
  return { servers, serverNames: Object.keys(servers), missingVars };
}

/**
 * Load MCP server config from a JSON file and expand environment variables.
 */
export async function loadMcpConfig(mcpPath: string, cwd: string): Promise<LoadedMcpConfig> {
  const fullPath = isAbsolute(mcpPath) ? mcpPath : resolve(cwd, mcpPath);

  let raw: string;
  try {
    raw = await readFile(fullPath, 'utf-8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      throw new Error(`MCP config file not found: ${mcpPath} (resolved to ${fullPath})`);
    }
    throw new Error(`Failed to read MCP config file: ${mcpPath} — ${e.message}`);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (parseErr) {
    const detail = (parseErr as SyntaxError).message;
    throw new Error(`MCP config file is not valid JSON: ${mcpPath} — ${detail}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`MCP config must be a JSON object (Record<string, ServerConfig>): ${mcpPath}`);
  }

  return expandEnvVars(parsed, mcpPath);
}
