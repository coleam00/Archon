/**
 * GitHub Copilot provider (community tier).
 *
 * Implements `IAgentProvider` on top of @github/copilot-sdk. The class is a
 * thin orchestrator: it owns the singleton `CopilotClient`, resolves auth +
 * binary path + reasoning/system config, creates or resumes a session, and
 * hands the streaming bridge off to `bridgeSession` in `event-bridge.ts`.
 *
 * Module-scope invariant: type-only imports from @github/copilot-sdk. Value
 * imports (`CopilotClient`, `approveAll`) go inside `sendQuery` /
 * `getCopilotClient` via dynamic `await import(...)`. `provider-lazy-load.test.ts`
 * asserts this so a future SDK update that reads the filesystem at module
 * load can't break compiled-binary bootstrap.
 */
import { createLogger } from '@archon/paths';
import type {
  CopilotClient,
  CopilotClientOptions,
  CopilotSession,
  SessionConfig,
  SystemMessageConfig,
} from '@github/copilot-sdk';

// `ReasoningEffort` is defined in the SDK but not re-exported from its barrel
// (as of @github/copilot-sdk@0.2.2). Mirror the enum literally so we don't
// depend on an internal subpath.
type CopilotReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
} from '../../types';
import { COPILOT_CAPABILITIES } from './capabilities';
import { parseCopilotConfig, type CopilotProviderDefaults } from './config';
import { resolveCopilotBinaryPath } from './binary-resolver';
import { bridgeSession } from './event-bridge';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.copilot');
  return cachedLog;
}

// Module-level singleton handle for the Copilot CLI client. Reset via
// `resetCopilotSingleton()` in tests — mirrors the Codex provider's pattern.
let copilotClientPromise: Promise<CopilotClient> | null = null;

/**
 * Test-only reset of the module-level Copilot client singleton. Re-exported
 * from the package root for use by test harnesses; mirrors
 * `resetCodexSingleton`.
 */
export function resetCopilotSingleton(): void {
  copilotClientPromise = null;
}

/**
 * Lazily instantiate the shared Copilot CLI client. The SDK spawns a CLI
 * subprocess on first session use, so we cache the client across workflow
 * invocations within the same process. If the creation fails, the cached
 * promise is cleared so the next call can retry.
 */
async function getCopilotClient(cfg: CopilotProviderDefaults): Promise<CopilotClient> {
  if (copilotClientPromise) return copilotClientPromise;
  copilotClientPromise = (async (): Promise<CopilotClient> => {
    const sdk = await import('@github/copilot-sdk');
    const cliPath = await resolveCopilotBinaryPath(cfg.cliPath);
    const opts: CopilotClientOptions = {
      logLevel: 'error',
    };
    if (cliPath) opts.cliPath = cliPath;
    if (cfg.githubToken) opts.githubToken = cfg.githubToken;
    return new sdk.CopilotClient(opts);
  })().catch((err: unknown) => {
    copilotClientPromise = null;
    throw err;
  });
  return copilotClientPromise;
}

/**
 * Options that Archon workflow YAML may set on a node but that Copilot does
 * not support. Capability flags in `COPILOT_CAPABILITIES` already drive the
 * dag-executor's generic warnings; this list is the provider-local echo that
 * logs at the provider boundary for operator visibility.
 *
 * Deliberately NOT in this list:
 *   - `effort` / `thinking` — we support these via reasoningEffort
 *   - `forkSession` / `persistSession` — we log-warn in a dedicated block
 *     (boolean values need different handling than structured options)
 */
const COPILOT_UNSUPPORTED_OPTIONS = [
  'mcp',
  'hooks',
  'skills',
  'agents',
  'allowed_tools',
  'denied_tools',
  'output_format',
  'sandbox',
  'betas',
  'fallbackModel',
  'webSearchMode',
  'additionalDirectories',
] as const;

function warnUnsupportedOptions(options: SendQueryOptions | undefined): void {
  const nodeConfig = options?.nodeConfig;
  if (!nodeConfig) return;
  const log = getLog();
  for (const opt of COPILOT_UNSUPPORTED_OPTIONS) {
    if (nodeConfig[opt] !== undefined) {
      log.warn({ option: opt }, 'copilot.option_not_supported');
    }
  }
  // forkSession / persistSession are boolean flags the executor may set in
  // normal operation; log-warn rather than throw (PR #1111's throw blocked
  // ordinary session reuse).
  if (options?.forkSession !== undefined) {
    log.warn({ option: 'forkSession', value: options.forkSession }, 'copilot.option_not_supported');
  }
  if (options?.persistSession !== undefined) {
    log.warn(
      { option: 'persistSession', value: options.persistSession },
      'copilot.option_not_supported'
    );
  }
}

/**
 * Resolve the reasoning effort passed to the SDK. Precedence:
 *   nodeConfig.effort > config.modelReasoningEffort
 *
 * The SDK enum is `'low' | 'medium' | 'high' | 'xhigh'`. Archon's workflow
 * `effort` schema is `'low' | 'medium' | 'high' | 'max'` (dag-node.ts) — we
 * map `'max'` to the SDK's `'xhigh'`. Codex-only tiers (`'minimal'`) and the
 * `'off'` sentinel are dropped with a log-warn.
 */
function resolveReasoningEffort(
  options: SendQueryOptions | undefined,
  config: CopilotProviderDefaults
): CopilotReasoningEffort | undefined {
  const raw = options?.nodeConfig?.effort ?? config.modelReasoningEffort;
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') return undefined;
  if (raw === 'off') return undefined;
  if (raw === 'max') return 'xhigh';
  if (raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'xhigh') {
    return raw;
  }
  getLog().warn({ effort: raw }, 'copilot.effort_unsupported');
  return undefined;
}

/**
 * Build the SDK's `SystemMessageConfig` from Archon's inputs. Precedence:
 *   requestOptions.systemPrompt > nodeConfig.systemPrompt > config.systemMessage
 *
 * When the source is the plain `systemPrompt` string (from request/node),
 * we default to `mode: 'append'` — additive, safe. Explicit `systemMessage`
 * in config can override the mode.
 */
function resolveSystemMessage(
  options: SendQueryOptions | undefined,
  config: CopilotProviderDefaults
): SystemMessageConfig | undefined {
  const requestPrompt = options?.systemPrompt;
  const nodePrompt =
    typeof options?.nodeConfig?.systemPrompt === 'string'
      ? options.nodeConfig.systemPrompt
      : undefined;
  const plainPrompt = requestPrompt ?? nodePrompt;
  if (typeof plainPrompt === 'string' && plainPrompt.length > 0) {
    return { mode: 'append', content: plainPrompt };
  }
  if (config.systemMessage) {
    // Config already validated the shape in parseCopilotConfig. Mode defaults
    // to 'append' when absent — pass through as-is.
    const { content, mode } = config.systemMessage;
    return { mode: mode ?? 'append', content };
  }
  return undefined;
}

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
    warnUnsupportedOptions(requestOptions);

    const assistantConfig = requestOptions?.assistantConfig ?? {};
    const copilotConfig = parseCopilotConfig(assistantConfig);

    const model = requestOptions?.model ?? copilotConfig.model ?? 'auto';

    const reasoningEffort = resolveReasoningEffort(requestOptions, copilotConfig);
    const systemMessage = resolveSystemMessage(requestOptions, copilotConfig);

    const { approveAll } = await import('@github/copilot-sdk');
    const client = await getCopilotClient(copilotConfig);

    const sessionOpts: SessionConfig = {
      model,
      workingDirectory: cwd,
      streaming: true,
      onPermissionRequest: approveAll,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(systemMessage ? { systemMessage } : {}),
    };

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
    if (resumeSessionId && !wantsFork) {
      log.debug({ sessionId: resumeSessionId, cwd }, 'copilot.resume_attempt');
      try {
        session = await client.resumeSession(resumeSessionId, sessionOpts);
      } catch (err) {
        log.debug(
          { err, sessionId: resumeSessionId },
          'copilot.resume_failed_falling_back_to_create'
        );
        resumeFailed = true;
        session = await client.createSession(sessionOpts);
      }
    } else {
      if (resumeSessionId && wantsFork) {
        log.warn(
          { requestedResumeSessionId: resumeSessionId },
          'copilot.fork_unsupported_creating_fresh_session'
        );
        forkedToFresh = true;
      } else {
        log.debug({ cwd, model }, 'copilot.create_session');
      }
      session = await client.createSession(sessionOpts);
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
        model,
        cwd,
        reasoningEffort,
        hasSystemMessage: systemMessage !== undefined,
        resumed: resumeSessionId !== undefined && !resumeFailed,
      },
      'copilot.session_started'
    );

    try {
      yield* bridgeSession(session, prompt, requestOptions?.abortSignal);
      log.info({ sessionId: session.sessionId }, 'copilot.prompt_completed');
    } catch (err) {
      log.error({ err, sessionId: session.sessionId }, 'copilot.prompt_failed');
      throw err;
    }
  }
}
