/**
 * GitHub Copilot provider (community tier).
 *
 * Implements `IAgentProvider` on top of @github/copilot-sdk. Resolves auth +
 * binary path + reasoning config, translates Archon workflow options
 * (tool restrictions, MCP servers, skills, agents, structured output) to the
 * SDK's `SessionConfig`, creates or resumes a session, and hands the
 * streaming bridge off to `bridgeSession` in `event-bridge.ts`.
 *
 * Module-scope invariant: type-only imports from @github/copilot-sdk. All
 * value imports (`CopilotClient`, `approveAll`) happen inside `sendQuery()`
 * via dynamic `await import(...)`. `provider-lazy-load.test.ts` asserts this
 * so a future SDK update that reads the filesystem at module load can't
 * break compiled-binary bootstrap.
 */
import { createLogger } from '@archon/paths';
import type {
  CopilotClientOptions,
  CopilotSession,
  CustomAgentConfig,
  MCPServerConfig,
  SessionConfig,
  SystemMessageConfig,
} from '@github/copilot-sdk';

import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
} from '../../types';
import { loadMcpConfig } from '../../claude/provider';
import { resolveSkillDirectories } from '../../shared/skills';
import { augmentPromptForJsonSchema } from '../../shared/structured-output';
import { COPILOT_CAPABILITIES } from './capabilities';
import { parseCopilotConfig, type CopilotProviderDefaults } from './config';
import { resolveCopilotBinaryPath } from './binary-resolver';
import { bridgeSession } from './event-bridge';

// `ReasoningEffort` is defined in the SDK but not re-exported from its barrel
// (as of @github/copilot-sdk@0.2.2). Mirror the enum literally so we don't
// depend on an internal subpath.
type CopilotReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

/**
 * Env var names the SDK reads for GitHub Copilot auth, in precedence order.
 * `COPILOT_GITHUB_TOKEN` is the Copilot-specific name and wins; `GH_TOKEN`
 * and `GITHUB_TOKEN` are the conventional gh-cli fallbacks.
 */
const AUTH_ENV_KEYS = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] as const;

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.copilot');
  return cachedLog;
}

/**
 * No-op kept for back-compat with tests that previously called into the
 * singleton-reset API. The client is now constructed fresh per `sendQuery()`
 * so each request sees correct per-request env vars.
 */
export function resetCopilotSingleton(): void {
  /* no-op — retained for API back-compat */
}

// ─── Warning collection ─────────────────────────────────────────────────────

/** Structured provider warning collected during translation; flushed as a system chunk. */
interface ProviderWarning {
  code: string;
  message: string;
}

// ─── Env + auth ─────────────────────────────────────────────────────────────

/**
 * Merge process.env with per-request env vars from the workflow node's
 * codebase-scoped env bag. Request env wins — matches the layering
 * Claude/Codex use for their SDK env handoff.
 */
function buildCopilotEnv(requestEnv?: Record<string, string>): Record<string, string> {
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  return { ...baseEnv, ...(requestEnv ?? {}) };
}

/** First non-empty value from AUTH_ENV_KEYS, or undefined if none set. */
function resolveGitHubToken(env: Record<string, string>): string | undefined {
  for (const key of AUTH_ENV_KEYS) {
    const value = env[key];
    if (value) return value;
  }
  return undefined;
}

// ─── Reasoning ──────────────────────────────────────────────────────────────

function normalizeReasoning(value: unknown): CopilotReasoningEffort | undefined {
  if (value === 'max') return 'xhigh';
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh') return value;
  return undefined;
}

/**
 * Resolve Copilot's `reasoningEffort` from Archon's workflow inputs.
 * Precedence:
 *   nodeConfig.thinking > nodeConfig.effort > config.modelReasoningEffort
 *
 * Archon's `effort` schema is `'low' | 'medium' | 'high' | 'max'` — we map
 * `'max'` to the SDK's `'xhigh'`. The `'off'` sentinel disables reasoning.
 * The object form of `thinking` (Claude-specific) returns a warning.
 */
function resolveCopilotReasoning(
  nodeConfig: SendQueryOptions['nodeConfig'] | undefined,
  copilotConfig: CopilotProviderDefaults
): { effort: CopilotReasoningEffort | undefined; warning?: string } {
  if (!nodeConfig) {
    return { effort: copilotConfig.modelReasoningEffort };
  }

  const rawThinking = nodeConfig.thinking;
  const rawEffort = nodeConfig.effort;

  if (rawThinking === 'off' || rawEffort === 'off') return { effort: undefined };

  const fromThinking = normalizeReasoning(rawThinking);
  if (fromThinking) return { effort: fromThinking };

  const fromEffort = normalizeReasoning(rawEffort);
  if (fromEffort) return { effort: fromEffort };

  if (rawThinking !== undefined && rawThinking !== null && typeof rawThinking === 'object') {
    return {
      effort: undefined,
      warning:
        'Copilot ignored `thinking` (object form is Claude-specific). Use `effort: low|medium|high|max` instead.',
    };
  }

  if (typeof rawThinking === 'string' || typeof rawEffort === 'string') {
    const offender = typeof rawThinking === 'string' ? rawThinking : rawEffort;
    return {
      effort: undefined,
      warning: `Copilot ignored unknown reasoning level '${String(offender)}'. Valid: low, medium, high, xhigh, max, off.`,
    };
  }

  // Fall back to config-level default when nodeConfig provides nothing actionable.
  return { effort: copilotConfig.modelReasoningEffort };
}

// ─── System prompt ──────────────────────────────────────────────────────────

function resolveSystemMessage(requestOptions?: SendQueryOptions): SystemMessageConfig | undefined {
  const requestPrompt = requestOptions?.systemPrompt;
  const nodePrompt =
    typeof requestOptions?.nodeConfig?.systemPrompt === 'string'
      ? requestOptions.nodeConfig.systemPrompt
      : undefined;
  const content = requestPrompt ?? nodePrompt;
  if (typeof content === 'string' && content.length > 0) {
    return { mode: 'append', content };
  }
  return undefined;
}

// ─── Translations ───────────────────────────────────────────────────────────

/**
 * Translate Archon's per-node `allowed_tools` / `denied_tools` to Copilot's
 * `availableTools` / `excludedTools`. Copilot's spec: `availableTools` takes
 * precedence over `excludedTools`; we pass both through when present and let
 * the SDK enforce precedence.
 */
function applyToolRestrictions(
  sessionConfig: SessionConfig,
  nodeConfig: SendQueryOptions['nodeConfig']
): void {
  if (!nodeConfig) return;
  if (nodeConfig.allowed_tools !== undefined) {
    sessionConfig.availableTools = nodeConfig.allowed_tools;
  }
  if (nodeConfig.denied_tools !== undefined) {
    sessionConfig.excludedTools = nodeConfig.denied_tools;
  }
}

/**
 * Translate Archon's `nodeConfig.mcp` (JSON-file path) to Copilot's
 * `SessionConfig.mcpServers`. Reuses Claude's `loadMcpConfig` so env-var
 * expansion and missing-var detection behave consistently across providers.
 */
async function applyMcpServers(
  sessionConfig: SessionConfig,
  nodeConfig: SendQueryOptions['nodeConfig'],
  cwd: string,
  warnings: ProviderWarning[]
): Promise<void> {
  const mcpPath = nodeConfig?.mcp;
  if (typeof mcpPath !== 'string' || mcpPath.length === 0) return;

  const { servers, serverNames, missingVars } = await loadMcpConfig(mcpPath, cwd);

  if (missingVars.length > 0) {
    warnings.push({
      code: 'copilot.mcp_env_vars_missing',
      message: `Copilot MCP config references undefined env vars: ${missingVars.join(', ')}. Servers using them may fail at runtime.`,
    });
  }

  sessionConfig.mcpServers = servers as Record<string, MCPServerConfig>;
  getLog().info({ serverNames, missingVars }, 'copilot.mcp_loaded');
}

/**
 * Translate Archon's `nodeConfig.skills` (string names) to Copilot's
 * `SessionConfig.skillDirectories` (absolute paths). Unresolved names become
 * a single system warning so the user notices the typo/missing skill.
 */
function applySkills(
  sessionConfig: SessionConfig,
  nodeConfig: SendQueryOptions['nodeConfig'],
  cwd: string,
  warnings: ProviderWarning[]
): void {
  if (!nodeConfig?.skills || nodeConfig.skills.length === 0) return;

  const { paths, missing } = resolveSkillDirectories(cwd, nodeConfig.skills);

  if (missing.length > 0) {
    warnings.push({
      code: 'copilot.skills_missing',
      message: `Copilot ignored missing skills: ${missing.join(', ')}. Expected a directory with SKILL.md under .agents/skills/ or .claude/skills/ (project or home).`,
    });
  }

  if (paths.length > 0) {
    sessionConfig.skillDirectories = paths;
  }
  getLog().info({ resolved: paths.length, missing }, 'copilot.skills_resolved');
}

/**
 * Translate Archon's `nodeConfig.agents` (Record<name, AgentDef>) to
 * Copilot's `SessionConfig.customAgents`. Only the fields Copilot's
 * `CustomAgentConfig` supports pass through (description, prompt, tools).
 * Archon agent fields Copilot cannot represent (`model`, `disallowedTools`,
 * `skills`, `maxTurns`) surface as one consolidated warning per agent.
 *
 * We do NOT set `SessionConfig.agent` — Archon's workflow model invokes
 * sub-agents via the Task tool, not by switching active agent at session
 * start.
 */
function applyAgents(
  sessionConfig: SessionConfig,
  nodeConfig: SendQueryOptions['nodeConfig'],
  warnings: ProviderWarning[]
): void {
  const agents = nodeConfig?.agents;
  if (!agents) return;
  const entries = Object.entries(agents);
  if (entries.length === 0) return;

  const customAgents: CustomAgentConfig[] = entries.map(([name, def]) => {
    const ignored: string[] = [];
    if (def.model !== undefined) ignored.push('model');
    if (def.disallowedTools !== undefined) ignored.push('disallowedTools');
    if (def.skills !== undefined) ignored.push('skills');
    if (def.maxTurns !== undefined) ignored.push('maxTurns');

    if (ignored.length > 0) {
      warnings.push({
        code: 'copilot.agent_fields_ignored',
        message: `Copilot agent '${name}' ignored unsupported fields: ${ignored.join(', ')}. Copilot supports description, prompt, tools (allowlist) only.`,
      });
    }

    return {
      name,
      description: def.description,
      prompt: def.prompt,
      ...(def.tools !== undefined ? { tools: def.tools } : {}),
    };
  });

  sessionConfig.customAgents = customAgents;
  getLog().info(
    { count: customAgents.length, names: customAgents.map(a => a.name) },
    'copilot.agents_registered'
  );
}

// ─── SessionConfig assembly ─────────────────────────────────────────────────

/**
 * Single construction site for the Copilot SessionConfig. Callers add new
 * translations as `applyX(sessionConfig, ..., warnings)` calls below — keep
 * business logic here straight-through.
 */
async function buildSessionConfig(
  copilotConfig: CopilotProviderDefaults,
  requestOptions: SendQueryOptions | undefined,
  cwd: string,
  approveAll: SessionConfig['onPermissionRequest'],
  warnings: ProviderWarning[]
): Promise<SessionConfig> {
  const reasoning = resolveCopilotReasoning(requestOptions?.nodeConfig, copilotConfig);
  if (reasoning.warning) {
    warnings.push({ code: 'copilot.reasoning_ignored', message: reasoning.warning });
  }

  const requestedModel = requestOptions?.model?.trim() || undefined;
  const defaultModel = copilotConfig.model?.trim() || undefined;
  // Default to 'auto' so Copilot picks a model when neither request nor
  // config names one. Matches the shipping Copilot CLI default.
  const resolvedModel = requestedModel ?? defaultModel ?? 'auto';

  const sessionConfig: SessionConfig = {
    model: resolvedModel,
    reasoningEffort: reasoning.effort,
    workingDirectory: cwd,
    configDir: copilotConfig.configDir,
    streaming: true,
    systemMessage: resolveSystemMessage(requestOptions),
    enableConfigDiscovery: copilotConfig.enableConfigDiscovery ?? false,
    onPermissionRequest: approveAll,
  };

  applyToolRestrictions(sessionConfig, requestOptions?.nodeConfig);
  await applyMcpServers(sessionConfig, requestOptions?.nodeConfig, cwd, warnings);
  applySkills(sessionConfig, requestOptions?.nodeConfig, cwd, warnings);
  applyAgents(sessionConfig, requestOptions?.nodeConfig, warnings);

  return sessionConfig;
}

// ─── Error classification ──────────────────────────────────────────────────

/** Best-effort stringify that never yields '[object Object]'. */
function safeErrorString(value: unknown): string {
  if (value === undefined || value === null) return 'Unknown error';
  if (typeof value === 'string') return value || 'Unknown error';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const json = JSON.stringify(value);
    if (json && json !== '{}') return json;
  } catch {
    /* fall through */
  }
  return 'Unknown error';
}

function isModelAccessError(errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase();
  const hasModel = normalized.includes('model');
  const hasAvailabilitySignal =
    normalized.includes('not available') ||
    normalized.includes('not found') ||
    normalized.includes('unsupported');
  return hasModel && hasAvailabilitySignal;
}

/**
 * Classify common Copilot failure modes and return a more actionable Error.
 * Combines the thrown message with any `lastSessionError` collected via the
 * SDK's `session.error` event — the latter often carries the specific
 * model-access / auth detail while the thrown error is generic.
 */
function buildFriendlyCopilotError(error: unknown, lastSessionError?: string): Error {
  const thrownMessage =
    error instanceof Error && error.message ? error.message : safeErrorString(error);
  const parts = [thrownMessage, lastSessionError].filter(
    (m): m is string => typeof m === 'string' && m.length > 0
  );
  const combined = parts.join('\n');

  if (isModelAccessError(combined)) {
    return new Error(
      `Copilot model access error: ${combined}\n\n` +
        'Try a different model in the workflow node or set assistants.copilot.model in .archon/config.yaml.'
    );
  }

  const normalized = combined.toLowerCase();
  if (
    normalized.includes('auth') ||
    normalized.includes('login') ||
    normalized.includes('unauthorized') ||
    normalized.includes('forbidden')
  ) {
    return new Error(
      `Copilot authentication failed: ${combined}\n\n` +
        'Run `copilot login`, or provide COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN.'
    );
  }

  return error instanceof Error ? error : new Error(combined);
}

// ─── Provider class ─────────────────────────────────────────────────────────

/**
 * GitHub Copilot community provider. Implements `IAgentProvider` on top of
 * `@github/copilot-sdk`, translating Archon workflow options (tools, MCP,
 * skills, agents, structured output, reasoning) to the SDK's `SessionConfig`,
 * bridging its event stream via `bridgeSession()`, and surfacing provider
 * signals (translation warnings, fork workaround, resume fallback) to the
 * caller. Each `sendQuery()` constructs a fresh `CopilotClient` so
 * per-request env vars are honored.
 */
export class CopilotProvider implements IAgentProvider {
  getType(): string {
    return 'copilot';
  }

  getCapabilities(): ProviderCapabilities {
    return COPILOT_CAPABILITIES;
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const log = getLog();

    // forkSession / persistSession are boolean flags the executor may set in
    // normal operation; log-warn rather than throw — throwing would block
    // ordinary session reuse.
    if (requestOptions?.forkSession !== undefined) {
      log.debug(
        { option: 'forkSession', value: requestOptions.forkSession },
        'copilot.option_not_supported'
      );
    }
    if (requestOptions?.persistSession !== undefined) {
      log.debug(
        { option: 'persistSession', value: requestOptions.persistSession },
        'copilot.option_not_supported'
      );
    }

    const assistantConfig = requestOptions?.assistantConfig ?? {};
    const copilotConfig = parseCopilotConfig(assistantConfig);

    const mergedEnv = buildCopilotEnv(requestOptions?.env);
    const githubToken = resolveGitHubToken(mergedEnv);
    const cliPath = await resolveCopilotBinaryPath(copilotConfig.copilotCliPath);

    const sdk = await import('@github/copilot-sdk');
    const { CopilotClient: copilotClientCtor, approveAll } = sdk;

    const warnings: ProviderWarning[] = [];
    const sessionConfig = await buildSessionConfig(
      copilotConfig,
      requestOptions,
      cwd,
      approveAll,
      warnings
    );

    // Flush translation warnings before session creation so the user sees
    // them even if session construction fails.
    for (const w of warnings) {
      yield { type: 'system', content: `⚠️ ${w.message}` };
    }

    // Best-effort structured output: Copilot has no native JSON-mode, so we
    // augment the prompt with the schema. bridgeSession parses the
    // accumulated assistant transcript and attaches `structuredOutput` to
    // the terminal result chunk.
    const outputFormat = requestOptions?.outputFormat;
    const wantsStructured = outputFormat?.type === 'json_schema';
    const effectivePrompt = wantsStructured
      ? augmentPromptForJsonSchema(prompt, outputFormat.schema)
      : prompt;

    const clientOpts: CopilotClientOptions = {
      cwd,
      env: mergedEnv,
    };
    if (cliPath) clientOpts.cliPath = cliPath;
    // `useLoggedInUser: true` set explicitly in config lets users keep
    // generic GH_TOKEN/GITHUB_TOKEN exported for other archon subsystems
    // (GitHub adapter, clone handler) while forcing Copilot to use the
    // CLI's stored Copilot-scoped OAuth — classic `ghp_` PATs have no
    // Copilot entitlement and the SDK rejects them with a misleading
    // "Session was not created with authentication info" error.
    const preferLoggedIn = copilotConfig.useLoggedInUser === true;
    if (githubToken && !preferLoggedIn) {
      clientOpts.githubToken = githubToken;
      clientOpts.useLoggedInUser = false;
    } else {
      clientOpts.useLoggedInUser = copilotConfig.useLoggedInUser ?? true;
    }
    if (copilotConfig.logLevel) clientOpts.logLevel = copilotConfig.logLevel;
    const client = new copilotClientCtor(clientOpts);

    let session: CopilotSession;
    let resumeFailed = false;
    let forkedToFresh = false;
    // Archon's dag-executor sets `forkSession: true` on every reuse so retries
    // start from the pre-node conversation state. The Copilot SDK has no fork
    // API — resumeSession mutates the source session in place. When fork is
    // requested we therefore create a fresh session rather than pollute the
    // source with retry attempts. That loses the prior conversation context,
    // but preserves retry correctness (which is what the executor cares about).
    const wantsFork = requestOptions?.forkSession === true;
    try {
      if (resumeSessionId && !wantsFork) {
        log.debug({ sessionId: resumeSessionId, cwd }, 'copilot.resume_attempt');
        try {
          session = await client.resumeSession(resumeSessionId, sessionConfig);
        } catch (err) {
          log.debug(
            { err, sessionId: resumeSessionId },
            'copilot.resume_failed_falling_back_to_create'
          );
          resumeFailed = true;
          session = await client.createSession(sessionConfig);
        }
      } else {
        if (resumeSessionId && wantsFork) {
          log.warn(
            { requestedResumeSessionId: resumeSessionId },
            'copilot.fork_unsupported_creating_fresh_session'
          );
          forkedToFresh = true;
        } else {
          log.debug({ cwd }, 'copilot.create_session');
        }
        session = await client.createSession(sessionConfig);
      }
    } catch (err) {
      // Can't connect / create — surface a friendly error and stop the client.
      try {
        await client.stop();
      } catch (stopErr) {
        log.debug({ err: stopErr }, 'copilot.client_stop_failed_after_session_error');
      }
      throw buildFriendlyCopilotError(err);
    }

    if (resumeFailed) {
      yield {
        type: 'system',
        content: '⚠️ Could not resume Copilot session — starting a fresh conversation.',
      };
    } else if (forkedToFresh) {
      yield {
        type: 'system',
        content:
          '⚠️ Copilot SDK does not support session forking; starting a fresh conversation to keep retries safe.',
      };
    }

    log.info(
      {
        sessionId: session.sessionId,
        model: sessionConfig.model,
        cwd,
        reasoningEffort: sessionConfig.reasoningEffort,
        hasSystemMessage: sessionConfig.systemMessage !== undefined,
        mcpServers: sessionConfig.mcpServers ? Object.keys(sessionConfig.mcpServers).length : 0,
        skills: sessionConfig.skillDirectories?.length ?? 0,
        agents: sessionConfig.customAgents?.length ?? 0,
        tokenSource: githubToken ? 'env' : 'logged-in-user',
        resumed: resumeSessionId !== undefined && !resumeFailed,
      },
      'copilot.session_started'
    );

    try {
      yield* bridgeSession(
        session,
        effectivePrompt,
        requestOptions?.abortSignal,
        wantsStructured ? outputFormat.schema : undefined
      );
      log.info({ sessionId: session.sessionId }, 'copilot.prompt_completed');
    } catch (err) {
      log.error({ err, sessionId: session.sessionId }, 'copilot.prompt_failed');
      throw buildFriendlyCopilotError(err);
    } finally {
      // Stop the client so its CLI subprocess shuts down; bridgeSession already
      // handled session.abort() + session.disconnect() in its own finally.
      try {
        const stopErrors = await client.stop();
        if (stopErrors.length > 0) {
          log.warn({ errors: stopErrors.map(e => e.message) }, 'copilot.client_stop_errors');
        }
      } catch (stopErr) {
        log.debug({ err: stopErr }, 'copilot.client_stop_threw');
      }
    }
  }
}
