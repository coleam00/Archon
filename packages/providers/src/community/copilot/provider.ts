import {
  CopilotClient,
  approveAll,
  type AssistantMessageEvent,
  type CustomAgentConfig,
  type MCPServerConfig,
  type SessionConfig,
  type SessionEvent,
} from '@github/copilot-sdk';
import { createLogger } from '@archon/paths';

import type { IAgentProvider, MessageChunk, SendQueryOptions } from '../../types';
import { loadMcpConfig } from '../../claude/provider';
import { resolveSkillDirectories } from '../../shared/skills';
import {
  augmentPromptForJsonSchema,
  tryParseStructuredOutput,
} from '../../shared/structured-output';
import { COPILOT_CAPABILITIES } from './capabilities';
import { resolveCopilotCliPath } from './binary-resolver';
import { parseCopilotConfig, type CopilotProviderDefaults } from './config';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.copilot');
  return cachedLog;
}

const SEND_AND_WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

const AUTH_ENV_KEYS = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] as const;
type CopilotReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

/** Structured provider warning collected during translation and flushed as a system chunk. */
interface ProviderWarning {
  code: string;
  message: string;
}

function buildCopilotEnv(requestEnv?: Record<string, string>): Record<string, string> {
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  return { ...baseEnv, ...(requestEnv ?? {}) };
}

function resolveGitHubToken(env: Record<string, string>): string | undefined {
  for (const key of AUTH_ENV_KEYS) {
    const value = env[key];
    if (value) return value;
  }
  return undefined;
}

function normalizeReasoning(value: unknown): CopilotReasoningEffort | undefined {
  if (value === 'max') return 'xhigh';
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh') return value;
  return undefined;
}

function resolveCopilotReasoning(nodeConfig?: SendQueryOptions['nodeConfig']): {
  effort: CopilotReasoningEffort | undefined;
  warning?: string;
} {
  if (!nodeConfig) return { effort: undefined };

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

  return { effort: undefined };
}

function buildSystemMessage(requestOptions?: SendQueryOptions): { content: string } | undefined {
  const systemPrompt = requestOptions?.systemPrompt ?? requestOptions?.nodeConfig?.systemPrompt;
  if (!systemPrompt) return undefined;
  return { content: systemPrompt };
}

/**
 * Translate Archon's per-node `allowed_tools` / `denied_tools` to Copilot's
 * `availableTools` / `excludedTools`. Copilot's spec: `availableTools` takes
 * precedence over `excludedTools`. We pass both through when present and let
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
 * a single system warning chunk so the user notices the typo/missing skill.
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
 * Copilot's `SessionConfig.customAgents`. Mapping is deliberately narrow —
 * only the fields Copilot's `CustomAgentConfig` supports pass through:
 *
 *   name        ← map key
 *   description ← agent.description
 *   prompt      ← agent.prompt
 *   tools       ← agent.tools (allowlist; Copilot has no per-agent denylist)
 *
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

/**
 * Single construction site for the Copilot SessionConfig. Each subsequent
 * workflow-parity phase adds one `applyX(sessionConfig, ..., warnings)` call
 * below this function — keep business logic here straight-through.
 */
async function buildSessionConfig(
  copilotConfig: CopilotProviderDefaults,
  requestOptions: SendQueryOptions | undefined,
  cwd: string,
  warnings: ProviderWarning[]
): Promise<SessionConfig> {
  const reasoning = resolveCopilotReasoning(requestOptions?.nodeConfig);
  if (reasoning.warning) {
    warnings.push({ code: 'copilot.reasoning_ignored', message: reasoning.warning });
  }

  const requestedModel = requestOptions?.model?.trim() || undefined;
  const defaultModel = copilotConfig.model?.trim() || undefined;

  const sessionConfig: SessionConfig = {
    model: requestedModel ?? defaultModel,
    reasoningEffort: reasoning.effort,
    workingDirectory: cwd,
    configDir: copilotConfig.configDir,
    streaming: true,
    systemMessage: buildSystemMessage(requestOptions),
    enableConfigDiscovery: copilotConfig.enableConfigDiscovery ?? false,
    onPermissionRequest: approveAll,
  };

  applyToolRestrictions(sessionConfig, requestOptions?.nodeConfig);
  await applyMcpServers(sessionConfig, requestOptions?.nodeConfig, cwd, warnings);
  applySkills(sessionConfig, requestOptions?.nodeConfig, cwd, warnings);
  applyAgents(sessionConfig, requestOptions?.nodeConfig, warnings);

  return sessionConfig;
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

function buildFriendlyCopilotError(error: unknown, lastSessionError?: string): Error {
  // A generic `sendAndWait` rejection often hides the actionable detail in
  // `session.error` (auth/model-access). Combine both for classification and
  // surface both in the user-visible message.
  const thrownMessage = error instanceof Error && error.message ? error.message : String(error);
  const combined = [thrownMessage, lastSessionError]
    .filter((m): m is string => Boolean(m))
    .join('\n');
  const rawMessage = combined || 'Unknown error';

  if (isModelAccessError(rawMessage)) {
    return new Error(
      `Copilot model access error: ${rawMessage}\n\n` +
        'Try a different model in the workflow node or set assistants.copilot.model in .archon/config.yaml.'
    );
  }

  const normalized = rawMessage.toLowerCase();
  if (
    normalized.includes('auth') ||
    normalized.includes('login') ||
    normalized.includes('unauthorized') ||
    normalized.includes('forbidden')
  ) {
    return new Error(
      `Copilot authentication failed: ${rawMessage}\n\n` +
        'Run `copilot login`, or provide COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN.'
    );
  }

  return error instanceof Error && !lastSessionError ? error : new Error(rawMessage);
}

class AsyncChunkQueue<T> {
  private values: T[] = [];
  private resolvers: ((result: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const resolver of this.resolvers.splice(0)) {
      resolver({ value: undefined, done: true });
    }
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.values.length > 0) {
      return { value: this.values.shift() as T, done: false };
    }
    if (this.closed) {
      return { value: undefined, done: true };
    }
    return await new Promise<IteratorResult<T>>(resolve => {
      this.resolvers.push(resolve);
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() };
  }
}

interface UsageAccumulator {
  input: number;
  output: number;
  cost?: number;
}

function addUsage(
  acc: UsageAccumulator,
  event: Extract<SessionEvent, { type: 'assistant.usage' }>
): void {
  acc.input += event.data.inputTokens ?? 0;
  acc.output += event.data.outputTokens ?? 0;
  if (typeof event.data.cost === 'number') {
    acc.cost = (acc.cost ?? 0) + event.data.cost;
  }
}

export class CopilotProvider implements IAgentProvider {
  getType(): string {
    return 'copilot';
  }

  getCapabilities(): typeof COPILOT_CAPABILITIES {
    return COPILOT_CAPABILITIES;
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const queue = new AsyncChunkQueue<MessageChunk>();

    let runError: Error | undefined;
    // Hoisted so the outer generator can abort the SDK run if the caller
    // stops iterating before the queue closes (e.g. early `break` or thrown
    // error in the consumer). Without this, `sendAndWait` would keep running
    // up to the 24h ceiling.
    let activeSession: Awaited<ReturnType<CopilotClient['createSession']>> | undefined;
    let runFinished = false;
    (async (): Promise<void> => {
      const assistantConfig = requestOptions?.assistantConfig ?? {};
      const copilotConfig = parseCopilotConfig(assistantConfig);
      const mergedEnv = buildCopilotEnv(requestOptions?.env);
      const githubToken = resolveGitHubToken(mergedEnv);
      const cliPath = await resolveCopilotCliPath(copilotConfig.copilotCliPath);

      const warnings: ProviderWarning[] = [];
      const sessionConfig = await buildSessionConfig(copilotConfig, requestOptions, cwd, warnings);

      for (const w of warnings) {
        queue.push({ type: 'system', content: `⚠️ ${w.message}` });
      }

      const client = new CopilotClient({
        cliPath,
        cwd,
        env: mergedEnv,
        githubToken,
        useLoggedInUser: githubToken ? false : (copilotConfig.useLoggedInUser ?? true),
        logLevel: copilotConfig.logLevel,
      });

      let session: Awaited<ReturnType<CopilotClient['createSession']>> | undefined;
      let lastSessionError: string | undefined;
      const streamedMessageIds = new Set<string>();
      const streamedReasoningIds = new Set<string>();
      const toolNames = new Map<string, string>();
      const usage: UsageAccumulator = { input: 0, output: 0 };
      let sawAssistantContent = false;

      // Best-effort structured output: Copilot has no native JSON-mode, so we
      // augment the prompt with the schema and parse the accumulated assistant
      // transcript at the end. Parse failure → leave `structuredOutput` unset
      // and let the dag-executor surface its existing missing-output warning.
      const outputFormat = requestOptions?.outputFormat;
      const wantsStructured = outputFormat?.type === 'json_schema';
      const effectivePrompt = wantsStructured
        ? augmentPromptForJsonSchema(prompt, outputFormat.schema)
        : prompt;
      let assistantBuffer = '';

      try {
        session = resumeSessionId
          ? await client.resumeSession(resumeSessionId, sessionConfig)
          : await client.createSession(sessionConfig);
        activeSession = session;

        session.on('assistant.reasoning_delta', event => {
          streamedReasoningIds.add(event.data.reasoningId);
          if (event.data.deltaContent) {
            queue.push({ type: 'thinking', content: event.data.deltaContent });
          }
        });

        session.on('assistant.reasoning', event => {
          if (streamedReasoningIds.has(event.data.reasoningId)) return;
          if (event.data.content) {
            queue.push({ type: 'thinking', content: event.data.content });
          }
        });

        session.on('assistant.message_delta', event => {
          streamedMessageIds.add(event.data.messageId);
          if (event.data.deltaContent) {
            sawAssistantContent = true;
            assistantBuffer += event.data.deltaContent;
            queue.push({ type: 'assistant', content: event.data.deltaContent });
          }
        });

        session.on('assistant.message', event => {
          if (streamedMessageIds.has(event.data.messageId)) return;
          if (event.data.content) {
            sawAssistantContent = true;
            assistantBuffer += event.data.content;
            queue.push({ type: 'assistant', content: event.data.content });
          }
        });

        session.on('assistant.usage', event => {
          addUsage(usage, event);
        });

        session.on('tool.execution_start', event => {
          toolNames.set(event.data.toolCallId, event.data.toolName);
          queue.push({
            type: 'tool',
            toolName: event.data.toolName,
            toolInput: event.data.arguments,
            toolCallId: event.data.toolCallId,
          });
        });

        session.on('tool.execution_complete', event => {
          queue.push({
            type: 'tool_result',
            toolName: toolNames.get(event.data.toolCallId) ?? 'unknown',
            toolOutput: event.data.result?.detailedContent ?? event.data.result?.content ?? '',
            toolCallId: event.data.toolCallId,
          });
        });

        session.on('session.error', event => {
          lastSessionError = event.data.message;
        });

        const abortSignal = requestOptions?.abortSignal;
        // `addEventListener('abort', ...)` is a no-op on an already-aborted
        // signal, so short-circuit before handing the 24-hour sendAndWait
        // path a signal that will never fire.
        if (abortSignal?.aborted) {
          throw new DOMException('Copilot sendQuery aborted before start', 'AbortError');
        }
        const onAbort = (): void => {
          if (!session) return;
          void session.abort().catch(err => {
            getLog().warn({ err }, 'copilot.abort_failed');
          });
        };
        abortSignal?.addEventListener('abort', onAbort, { once: true });

        let finalMessage: AssistantMessageEvent | undefined;
        try {
          finalMessage = await session.sendAndWait(
            { prompt: effectivePrompt },
            SEND_AND_WAIT_TIMEOUT_MS
          );
        } finally {
          abortSignal?.removeEventListener('abort', onAbort);
        }

        if (!sawAssistantContent && finalMessage?.data.content) {
          sawAssistantContent = true;
          assistantBuffer += finalMessage.data.content;
          queue.push({ type: 'assistant', content: finalMessage.data.content });
        }

        if (!sawAssistantContent && lastSessionError) {
          queue.push({ type: 'system', content: `⚠️ ${lastSessionError}` });
        }

        const structuredOutput = wantsStructured
          ? tryParseStructuredOutput(assistantBuffer)
          : undefined;

        queue.push({
          type: 'result',
          sessionId: session.sessionId,
          tokens:
            usage.input > 0 || usage.output > 0 || usage.cost !== undefined
              ? {
                  input: usage.input,
                  output: usage.output,
                  total: usage.input + usage.output,
                  cost: usage.cost,
                }
              : undefined,
          cost: usage.cost,
          ...(structuredOutput !== undefined ? { structuredOutput } : {}),
        });
      } catch (error) {
        throw buildFriendlyCopilotError(error, lastSessionError);
      } finally {
        // Cleanup must not throw — doing so would replace the primary
        // result/error from the try block above. Log and swallow.
        try {
          await session?.disconnect();
        } catch (err) {
          getLog().warn({ err }, 'copilot.disconnect_failed');
        }
        try {
          const stopErrors = await client.stop();
          if (stopErrors.length > 0) {
            getLog().warn(
              { errors: stopErrors.map(err => err.message) },
              'copilot.client_stop_errors'
            );
          }
        } catch (err) {
          getLog().warn({ err }, 'copilot.client_stop_threw');
        }
      }
    })()
      .catch(error => {
        runError = error as Error;
      })
      .finally(() => {
        runFinished = true;
        queue.close();
      });

    try {
      for await (const chunk of queue) {
        yield chunk;
      }
    } finally {
      // If the consumer stops iterating before the run finishes (early break,
      // thrown error in caller, generator.return()), drain the SDK session so
      // we don't keep paying for a sendAndWait that nobody will read.
      if (!runFinished && activeSession) {
        queue.close();
        void activeSession.abort().catch(err => {
          getLog().warn({ err }, 'copilot.abort_failed');
        });
      }
    }

    if (runError) throw runError;
  }
}
