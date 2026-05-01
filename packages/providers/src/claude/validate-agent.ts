/**
 * Smoke-validates an agent definition by running a one-turn `query()` and
 * inspecting the SDK's system.init message + result event for evidence that:
 *   - the model resolved
 *   - the requested tools loaded
 *   - any MCP servers connected
 *   - skills the agent referenced are actually available
 *
 * Used by the Web UI's "Validate" button. Read-only with respect to the
 * project — runs Claude in `bypassPermissions` mode so tool execution is
 * permitted, but the smoke prompt is "say 'ok' and nothing else", which
 * shouldn't trigger any tool. The result is structured for UI consumption.
 */

import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { isAbsolute, resolve } from 'path';
import { readFile } from 'fs/promises';
import { resolveClaudeBinaryPath } from './binary-resolver';

export interface AgentValidationFrontmatter {
  name: string;
  model?: string | null;
  /** Built-in tool allowlist passed verbatim to SDK `tools`. */
  tools?: string[];
  /** Built-in tool denylist passed to SDK `disallowedTools`. */
  disallowedTools?: string[];
  /** Path to MCP server JSON file (relative to cwd or absolute). */
  mcp?: string;
  /** Skill names to load. */
  skills?: string[];
  maxTurns?: number;
}

export interface ValidateAgentResult {
  ok: boolean;
  model: string | null;
  activeTools: string[];
  mcpServers: { name: string; status: string }[];
  skillsLoaded: string[];
  missingEnvVars: string[];
  warnings: string[];
  errors: string[];
  sampleReply: string | null;
  costUsd: number | null;
}

/** Expand `$VAR` references inside the env / headers blocks of an MCP config. */
function expandEnvVarsInRecord(
  record: Record<string, unknown>,
  missingVars: string[]
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    if (typeof v !== 'string') {
      result[k] = String(v);
      continue;
    }
    result[k] = v.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, varName: string) => {
      const envVal = process.env[varName];
      if (envVal === undefined) missingVars.push(varName);
      return envVal ?? '';
    });
  }
  return result;
}

async function loadMcpConfigSafe(
  mcpPath: string,
  cwd: string
): Promise<{
  servers: Record<string, unknown>;
  serverNames: string[];
  missingVars: string[];
  error: string | null;
}> {
  const fullPath = isAbsolute(mcpPath) ? mcpPath : resolve(cwd, mcpPath);
  let raw: string;
  try {
    raw = await readFile(fullPath, 'utf-8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return {
      servers: {},
      serverNames: [],
      missingVars: [],
      error: `Failed to read MCP config '${mcpPath}': ${e.message}`,
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    return {
      servers: {},
      serverNames: [],
      missingVars: [],
      error: `MCP config '${mcpPath}' is not valid JSON: ${(err as Error).message}`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      servers: {},
      serverNames: [],
      missingVars: [],
      error: `MCP config '${mcpPath}' must be a JSON object keyed by server name`,
    };
  }

  const missingVars: string[] = [];
  const servers: Record<string, unknown> = {};
  for (const [serverName, serverConfig] of Object.entries(parsed)) {
    if (typeof serverConfig !== 'object' || serverConfig === null) continue;
    const cfg = { ...(serverConfig as Record<string, unknown>) };
    if (cfg.env && typeof cfg.env === 'object') {
      cfg.env = expandEnvVarsInRecord(cfg.env as Record<string, unknown>, missingVars);
    }
    if (cfg.headers && typeof cfg.headers === 'object') {
      cfg.headers = expandEnvVarsInRecord(cfg.headers as Record<string, unknown>, missingVars);
    }
    servers[serverName] = cfg;
  }
  return { servers, serverNames: Object.keys(servers), missingVars, error: null };
}

/**
 * Run the smoke validation. Always returns a result — never throws. On any
 * unexpected failure the error is captured in `errors[]` and `ok` is false.
 *
 * The smoke prompt is intentionally trivial so we don't burn budget. Most
 * fields are derived from the SDK's `system.init` event, which arrives before
 * any tool use, so even if the model decides not to reply we still get the
 * full configuration introspection.
 */
export interface ValidateAgentSmokeOptions {
  /** Override the smoke prompt. Defaults to the trivial "say ok" prompt. */
  prompt?: string;
  /** Override the Claude binary path. */
  claudeBinaryPath?: string;
}

export async function validateAgentSmoke(
  cwd: string,
  fm: AgentValidationFrontmatter,
  systemPromptBody: string,
  optionsOrBinaryPath?: ValidateAgentSmokeOptions | string
): Promise<ValidateAgentResult> {
  const opts: ValidateAgentSmokeOptions =
    typeof optionsOrBinaryPath === 'string'
      ? { claudeBinaryPath: optionsOrBinaryPath }
      : (optionsOrBinaryPath ?? {});
  const claudeBinaryPath = opts.claudeBinaryPath;
  const userPrompt = opts.prompt ?? "Reply with the literal string 'ok' and nothing else.";
  const result: ValidateAgentResult = {
    ok: false,
    model: null,
    activeTools: [],
    mcpServers: [],
    skillsLoaded: [],
    missingEnvVars: [],
    warnings: [],
    errors: [],
    sampleReply: null,
    costUsd: null,
  };

  const cliPath = await resolveClaudeBinaryPath(claudeBinaryPath).catch(() => undefined);

  const options: Options = {
    cwd,
    ...(cliPath !== undefined ? { pathToClaudeCodeExecutable: cliPath } : {}),
    systemPrompt: systemPromptBody.trim().length > 0 ? systemPromptBody : undefined,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: ['project'],
  };

  if (fm.model) options.model = fm.model;
  if (fm.tools) options.tools = fm.tools;
  if (fm.disallowedTools) options.disallowedTools = fm.disallowedTools;
  if (typeof fm.maxTurns === 'number') options.maxTurns = fm.maxTurns;
  if (fm.skills && fm.skills.length > 0) {
    options.skills = fm.skills;
  }

  if (fm.mcp) {
    const mcp = await loadMcpConfigSafe(fm.mcp, cwd);
    if (mcp.error) {
      result.errors.push(mcp.error);
    } else {
      options.mcpServers = mcp.servers as Options['mcpServers'];
      const wildcards = mcp.serverNames.map(n => `mcp__${n}__*`);
      options.allowedTools = [...(options.allowedTools ?? []), ...wildcards];
      if (mcp.missingVars.length > 0) {
        result.missingEnvVars = [...new Set(mcp.missingVars)];
        result.warnings.push(
          `MCP config references undefined env vars: ${result.missingEnvVars.join(', ')}`
        );
      }
      if (options.model?.toLowerCase().includes('haiku')) {
        result.warnings.push(
          'Haiku models do not support tool search (lazy loading) for many MCP tools. Consider Sonnet or Opus.'
        );
      }
    }
  }

  let assistantText = '';
  try {
    for await (const msg of query({ prompt: userPrompt, options })) {
      const event = msg as { type?: string };
      if (event.type === 'system') {
        const sys = msg as {
          subtype?: string;
          model?: string;
          tools?: string[];
          mcp_servers?: { name: string; status: string }[];
          skills?: string[];
        };
        if (sys.subtype === 'init') {
          if (typeof sys.model === 'string') result.model = sys.model;
          if (Array.isArray(sys.tools)) result.activeTools = [...sys.tools];
          if (Array.isArray(sys.mcp_servers)) {
            result.mcpServers = sys.mcp_servers.map(s => ({ name: s.name, status: s.status }));
            const failed = sys.mcp_servers.filter(s => s.status !== 'connected');
            if (failed.length > 0) {
              result.warnings.push(
                `MCP server(s) failed to connect: ${failed.map(f => `${f.name} (${f.status})`).join(', ')}`
              );
            }
          }
          if (Array.isArray(sys.skills)) result.skillsLoaded = [...sys.skills];
        }
      } else if (event.type === 'assistant') {
        const am = msg as { message: { content: { type: string; text?: string }[] } };
        for (const block of am.message.content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            assistantText += block.text;
          }
        }
      } else if (event.type === 'result') {
        const rm = msg as {
          subtype?: string;
          is_error?: boolean;
          total_cost_usd?: number;
          errors?: string[];
        };
        if (typeof rm.total_cost_usd === 'number') result.costUsd = rm.total_cost_usd;
        if (rm.is_error) {
          result.errors.push(...(rm.errors ?? [`SDK reported ${rm.subtype ?? 'error'}`]));
        }
      }
    }
    result.sampleReply = assistantText.trim() || null;
    result.ok = result.errors.length === 0;
  } catch (err) {
    result.errors.push(`SDK query failed: ${(err as Error).message}`);
    result.ok = false;
  }

  return result;
}
