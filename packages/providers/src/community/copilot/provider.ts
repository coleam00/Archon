import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { createLogger } from '@archon/paths';

// IMPORTANT: Do NOT add static `import { ... } from '@github/copilot/copilot-sdk'` here.
// The SDK spawns a CLI subprocess and may run initialization code at module load that
// fails inside compiled Archon binaries where node_modules resolution is frozen.
// All SDK value bindings are dynamically imported inside `sendQuery()` below.
// Type-only imports above are erased by TypeScript — safe at module scope.
import type { CopilotClientOptions, SessionConfig } from '@github/copilot/copilot-sdk';

import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
} from '../../types';

import { COPILOT_CAPABILITIES } from './capabilities';
import { parseCopilotConfig } from './config';
import { resolveCopilotBinaryPath } from './binary-resolver';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.copilot');
  return cachedLog;
}

// ─── MCP Config Loading ──────────────────────────────────────────────────────

function expandEnvVarsInRecord(
  record: Record<string, unknown>,
  missingVars: string[]
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(record)) {
    if (typeof val !== 'string') {
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

function expandEnvVars(config: Record<string, unknown>): {
  expanded: Record<string, unknown>;
  missingVars: string[];
} {
  const result: Record<string, unknown> = {};
  const missingVars: string[] = [];
  for (const [serverName, serverConfig] of Object.entries(config)) {
    if (typeof serverConfig !== 'object' || serverConfig === null) {
      getLog().warn({ serverName }, 'copilot.mcp_server_config_not_object');
      continue;
    }
    const server = { ...(serverConfig as Record<string, unknown>) };
    if (server.env && typeof server.env === 'object') {
      server.env = expandEnvVarsInRecord(server.env as Record<string, unknown>, missingVars);
    }
    if (server.headers && typeof server.headers === 'object') {
      server.headers = expandEnvVarsInRecord(
        server.headers as Record<string, unknown>,
        missingVars
      );
    }
    result[serverName] = server;
  }
  return { expanded: result, missingVars };
}

async function loadMcpConfig(
  mcpPath: string,
  cwd: string
): Promise<{
  servers: Record<string, unknown>;
  serverNames: string[];
  missingVars: string[];
}> {
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

  const { expanded, missingVars } = expandEnvVars(parsed);
  const serverNames = Object.keys(expanded);
  return { servers: expanded, serverNames, missingVars };
}

/**
 * GitHub Copilot community provider — wraps `@github/copilot`'s ACP SDK.
 * Each `sendQuery()` call creates a fresh CopilotClient (new CLI process),
 * cleaned up in the finally block via `client.stop()`.
 */
export class CopilotSdkProvider implements IAgentProvider {
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    // Lazy-load SDK and bridge here — must not move to module scope.
    // See header comment: runtime values from @github/copilot/copilot-sdk
    // must not load at startup (compiled binary safety).
    // CopilotClient is PascalCase — access via module object to avoid naming-convention
    // eslint rule (same pattern as PiProvider's piCodingAgent.X access).
    const [copilotSdk, { bridgeCopilotSession }] = await Promise.all([
      import('@github/copilot/copilot-sdk'),
      import('./event-bridge'),
    ]);
    const { approveAll } = copilotSdk;

    const assistantConfig = requestOptions?.assistantConfig ?? {};
    const copilotConfig = parseCopilotConfig(assistantConfig);

    // Resolve model: request (workflow node) → config default
    const effectiveModel = requestOptions?.model ?? copilotConfig.model;

    // Resolve GitHub token: env vars take priority over config
    const githubToken =
      process.env.COPILOT_GITHUB_TOKEN ??
      process.env.GH_TOKEN ??
      process.env.GITHUB_TOKEN ??
      copilotConfig.githubToken;

    // Resolve CLI binary path (only matters in compiled binary mode)
    const cliPath = await resolveCopilotBinaryPath(copilotConfig.cliPath);

    // Load MCP config if specified
    const nodeConfig = requestOptions?.nodeConfig;
    let mcpServers: Record<string, unknown> | undefined;
    if (typeof nodeConfig?.mcp === 'string' && nodeConfig.mcp.length > 0) {
      const { servers, serverNames, missingVars } = await loadMcpConfig(nodeConfig.mcp, cwd);
      mcpServers = servers;
      if (missingVars.length > 0) {
        yield {
          type: 'system',
          content: `⚠️ Copilot MCP config: undefined env vars: ${missingVars.join(', ')}`,
        };
      }
      getLog().debug({ serverNames, missingVarCount: missingVars.length }, 'copilot.mcp_loaded');
    }

    // Build CopilotClientOptions
    const clientOptions: CopilotClientOptions = {
      ...(cliPath !== undefined ? { cliPath } : {}),
      ...(githubToken !== undefined ? { githubToken } : {}),
      ...(requestOptions?.env && Object.keys(requestOptions.env).length > 0
        ? { env: { ...process.env, ...requestOptions.env } as Record<string, string | undefined> }
        : {}),
      useStdio: true,
    };

    // Build SessionConfig.
    // ReasoningEffort is not re-exported from the index, extract from SessionConfig type.
    type ReasoningEffort = NonNullable<SessionConfig['reasoningEffort']>;

    const sessionConfig: SessionConfig = {
      workingDirectory: cwd,
      ...(effectiveModel ? { model: effectiveModel } : {}),
      onPermissionRequest: approveAll,
      ...(nodeConfig?.allowed_tools !== undefined
        ? { availableTools: nodeConfig.allowed_tools }
        : {}),
      ...(nodeConfig?.denied_tools !== undefined ? { excludedTools: nodeConfig.denied_tools } : {}),
      ...(nodeConfig?.effort ? { reasoningEffort: nodeConfig.effort as ReasoningEffort } : {}),
      ...(mcpServers ? { mcpServers: mcpServers as SessionConfig['mcpServers'] } : {}),
      ...(requestOptions?.systemPrompt
        ? { systemMessage: { mode: 'append', content: requestOptions.systemPrompt } }
        : {}),
    };

    getLog().info(
      {
        cwd,
        model: effectiveModel,
        hasToken: githubToken !== undefined,
        hasCliPath: cliPath !== undefined,
        hasMcp: mcpServers !== undefined,
        hasAllowedTools: nodeConfig?.allowed_tools !== undefined,
        hasDeniedTools: nodeConfig?.denied_tools !== undefined,
        hasEffort: nodeConfig?.effort !== undefined,
        resumed: resumeSessionId !== undefined,
      },
      'copilot.session_starting'
    );

    const client = new copilotSdk.CopilotClient(clientOptions);

    let session: Awaited<ReturnType<typeof client.createSession>>;
    if (resumeSessionId) {
      try {
        session = await client.resumeSession(resumeSessionId, sessionConfig);
      } catch (err) {
        getLog().warn({ err, resumeSessionId }, 'copilot.resume_failed');
        yield {
          type: 'system',
          content: '⚠️ Could not resume Copilot session. Starting fresh conversation.',
        };
        session = await client.createSession(sessionConfig);
      }
    } else {
      session = await client.createSession(sessionConfig);
    }

    try {
      yield* bridgeCopilotSession(session, client, prompt, requestOptions?.abortSignal);
      getLog().info({ cwd }, 'copilot.prompt_completed');
    } catch (err) {
      getLog().error({ err, cwd }, 'copilot.prompt_failed');
      throw err;
    }
  }

  getType(): string {
    return 'copilot';
  }

  getCapabilities(): ProviderCapabilities {
    return COPILOT_CAPABILITIES;
  }
}
