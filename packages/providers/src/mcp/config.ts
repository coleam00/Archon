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
    if (server.env !== undefined) {
      if (typeof server.env !== 'object' || server.env === null || Array.isArray(server.env)) {
        throw new ClassifiedProviderError(
          'misconfigured',
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
        throw new ClassifiedProviderError(
          'misconfigured',
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
