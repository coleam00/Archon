import { readFile } from 'fs/promises';
import { isAbsolute, resolve } from 'path';

type EnvSource = Record<string, string | undefined>;

export interface LoadedMcpConfig {
  servers: Record<string, unknown>;
  serverNames: string[];
  missingVars: string[];
}

function describeJsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Expand $VAR_NAME references in string-valued records from the supplied
 * environment source.
 */
function expandEnvVarsInRecord(
  record: Record<string, unknown>,
  missingVars: string[],
  envSource: EnvSource,
  fieldPath: string
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(record)) {
    if (typeof val !== 'string') {
      throw new Error(
        `MCP config ${fieldPath}.${key} must be a string (got ${describeJsonType(val)})`
      );
    }
    // Only uppercase env references are expanded; lowercase or mixed-case names are left literal.
    result[key] = val.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, varName: string) => {
      const envVal = envSource[varName];
      if (envVal === undefined) {
        missingVars.push(varName);
      }
      return envVal ?? '';
    });
  }
  return result;
}

function expandEnvVars(
  config: Record<string, unknown>,
  envSource: EnvSource
): {
  expanded: Record<string, unknown>;
  missingVars: string[];
} {
  const result: Record<string, unknown> = {};
  const missingVars: string[] = [];
  for (const [serverName, serverConfig] of Object.entries(config)) {
    if (typeof serverConfig !== 'object' || serverConfig === null || Array.isArray(serverConfig)) {
      throw new Error(
        `MCP server "${serverName}" must be a JSON object (got ${describeJsonType(serverConfig)})`
      );
    }
    const server = { ...(serverConfig as Record<string, unknown>) };
    if (server.env !== undefined) {
      if (typeof server.env !== 'object' || server.env === null || Array.isArray(server.env)) {
        throw new Error(
          `MCP config ${serverName}.env must be a JSON object of string values (got ${describeJsonType(server.env)})`
        );
      }
      server.env = expandEnvVarsInRecord(
        server.env as Record<string, unknown>,
        missingVars,
        envSource,
        `${serverName}.env`
      );
    }
    if (server.headers !== undefined) {
      if (
        typeof server.headers !== 'object' ||
        server.headers === null ||
        Array.isArray(server.headers)
      ) {
        throw new Error(
          `MCP config ${serverName}.headers must be a JSON object of string values (got ${describeJsonType(server.headers)})`
        );
      }
      server.headers = expandEnvVarsInRecord(
        server.headers as Record<string, unknown>,
        missingVars,
        envSource,
        `${serverName}.headers`
      );
    }
    result[serverName] = server;
  }
  return { expanded: result, missingVars };
}

function normalizeMcpConfig(
  parsed: Record<string, unknown>,
  mcpPath: string
): Record<string, unknown> {
  const keys = Object.keys(parsed);
  if (!keys.includes('mcpServers')) {
    return parsed;
  }

  if (keys.length > 1) {
    throw new Error(
      `MCP config cannot mix top-level "mcpServers" with other keys: ${mcpPath}. Use either a direct server map or { "mcpServers": { ... } }.`
    );
  }

  const servers = parsed.mcpServers;
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    throw new Error(`MCP config field "mcpServers" must be a JSON object: ${mcpPath}`);
  }

  return servers as Record<string, unknown>;
}

/**
 * Load MCP server config from a JSON file and expand environment variables.
 */
export async function loadMcpConfig(
  mcpPath: string,
  cwd: string,
  envSource: EnvSource = process.env
): Promise<LoadedMcpConfig> {
  const fullPath = isAbsolute(mcpPath) ? mcpPath : resolve(cwd, mcpPath);

  let raw: string;
  try {
    raw = await readFile(fullPath, 'utf-8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      throw new Error(`MCP config file not found: ${mcpPath} (resolved to ${fullPath})`);
    }
    throw new Error(`Failed to read MCP config file: ${mcpPath} - ${e.message}`);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (parseErr) {
    const detail = (parseErr as SyntaxError).message;
    throw new Error(`MCP config file is not valid JSON: ${mcpPath} - ${detail}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`MCP config must be a JSON object (Record<string, ServerConfig>): ${mcpPath}`);
  }

  const normalized = normalizeMcpConfig(parsed, mcpPath);
  const { expanded, missingVars } = expandEnvVars(normalized, envSource);
  const serverNames = Object.keys(expanded);
  return { servers: expanded, serverNames, missingVars };
}
