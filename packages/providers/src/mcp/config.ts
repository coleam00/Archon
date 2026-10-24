import { readFile } from 'fs/promises';
import { isAbsolute, resolve } from 'path';
import { mcpServerMap } from '@archon/provider-contract';
import { ClassifiedProviderError } from '../shared/failure';

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
 * Expand $VAR_NAME and ${VAR_NAME} references in string-valued records from
 * the supplied environment source.
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
      throw new ClassifiedProviderError(
        'misconfigured',
        `MCP config ${fieldPath}.${key} must be a string (got ${describeJsonType(val)})`
      );
    }
    result[key] = val.replace(
      /\$(?:\{([A-Z_][A-Z0-9_]*)\}|([A-Z_][A-Z0-9_]*))/g,
      (_, braced: string | undefined, bare: string | undefined) => {
        const varName = braced ?? bare ?? '';
        const envVal = envSource[varName];
        if (envVal === undefined) {
          missingVars.push(varName);
        }
        return envVal ?? '';
      }
    );
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
      throw new ClassifiedProviderError(
        'misconfigured',
        `MCP server "${serverName}" must be a JSON object (got ${describeJsonType(serverConfig)})`
      );
    }
    const server = { ...(serverConfig as Record<string, unknown>) };
    for (const field of ['env', 'headers'] as const) {
      if (server[field] === undefined) continue;
      server[field] = expandServerRecord(
        server[field],
        missingVars,
        envSource,
        `${serverName}.${field}`
      );
    }

    result[serverName] = server;
  }
  return { expanded: result, missingVars };
}

function expandServerRecord(
  value: unknown,
  missingVars: string[],
  envSource: EnvSource,
  fieldPath: string
): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ClassifiedProviderError(
      'misconfigured',
      `MCP config ${fieldPath} must be a JSON object of string values (got ${describeJsonType(value)})`
    );
  }
  return expandEnvVarsInRecord(value as Record<string, unknown>, missingVars, envSource, fieldPath);
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
      throw new ClassifiedProviderError(
        'misconfigured',
        `MCP config file not found: ${mcpPath} (resolved to ${fullPath})`
      );
    }
    const message = `Failed to read MCP config file: ${mcpPath} - ${e.message}`;
    // A path that names nothing readable is setup; EMFILE, EIO and the like can pass.
    if (e.code === 'EACCES' || e.code === 'EISDIR' || e.code === 'ENOTDIR') {
      throw new ClassifiedProviderError('misconfigured', message);
    }
    throw new Error(message);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (parseErr) {
    const detail = (parseErr as SyntaxError).message;
    throw new ClassifiedProviderError(
      'misconfigured',
      `MCP config file is not valid JSON: ${mcpPath} - ${detail}`
    );
  }

  const serverMap = mcpServerMap(parsed);
  if (!serverMap.ok) {
    throw new ClassifiedProviderError('misconfigured', `${serverMap.error}: ${mcpPath}`);
  }
  const { expanded, missingVars } = expandEnvVars(serverMap.servers, envSource);
  const serverNames = Object.keys(expanded);
  return { servers: expanded, serverNames, missingVars };
}
