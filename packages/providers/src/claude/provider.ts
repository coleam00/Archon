/**
 * Claude Agent SDK wrapper
 * Provides async generator interface for streaming Claude responses
 *
 * Type Safety Pattern:
 * - Uses `Options` type from SDK for query configuration
 * - SDK message types have strict type checking for content blocks
 * - Content blocks are typed via inline assertions for clarity
 *
 * Authentication:
 * - Credentials reach the subprocess via process.env (already cleaned by
 *   stripCwdEnv) PLUS any per-request `requestOptions.env` (per-user delivered
 *   keys/subscriptions), merged LAST so it wins. `buildProviderSubprocessEnv` does NOT
 *   filter tokens — the Claude wrapper logs which posture process.env shows (explicit
 *   token present vs not); the historical env-token allowlist was removed in
 *   #1067, so the log can read "global" while a per-request token authenticates.
 * - CLAUDE_USE_GLOBAL_AUTH is an Archon-only boot sentinel (set for solo
 *   installs with no creds — see server/src/boot/claude-auth-posture.ts). The
 *   Claude CLI itself ignores it; it neither gates nor filters env here.
 *
 * Binary resolution:
 * - In compiled binaries, `pathToClaudeCodeExecutable` is resolved from
 *   `CLAUDE_BIN_PATH` env or `assistants.claude.claudeBinaryPath` config;
 *   see ./binary-resolver.ts. In dev mode the resolver returns undefined
 *   and the SDK picks its bundled per-platform native binary (Mach-O/ELF/PE
 *   from `@anthropic-ai/claude-agent-sdk-<platform>` optional dep). Pre-0.2.x
 *   SDKs shipped `cli.js` in the package and dev mode resolved that JS file;
 *   the SDK switched to native binaries in the 0.2.x series. See
 *   `shouldPassNoEnvFile` for the implications on the `--no-env-file` flag.
 */
import { exec, execFile, spawn, type ExecFileException } from 'node:child_process';
import { z } from 'zod';
import {
  collectCredentialValues,
  redactCredentialValues,
} from '@archon/paths/credential-redaction';
import { buildProviderSubprocessEnv } from '@archon/provider-contract';
import type { CredentialStatus, ProviderDiagnostics } from '@archon/provider-contract';
import {
  query,
  type Options,
  type HookCallback,
  type PostToolUseFailureHookInput,
  type PostToolUseHookInput,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  IAgentProvider,
  SendQueryOptions,
  MessageChunk,
  ProviderCapabilities,
} from '../types';
import { sessionPreview, truncateToolOutput } from '@archon/provider-contract';
import { parseClaudeConfig } from './config';
import { CLAUDE_CAPABILITIES } from './capabilities';
import { buildContainerSpawn, buildDockerExecPrefix } from './container-spawn';
import { resolveClaudeBinaryPath, resolveClaudeBinaryWithSource } from './binary-resolver';
import { buildArchonMcpServer, ARCHON_TOOL_SERVER } from './native-tools';
import { readSessionSpendBaseline } from './session-spend-reader';
import { createLogger } from '@archon/paths';
import { withResumedOutcome, resumedOutcome } from '../shared/resumed';
import { closeOpenToolCalls } from '../shared/tool-calls';
import { diagnoseBinary } from '../shared/binary-diagnostics';
import { buildPluginListCommand, readClaudePluginIds, withPluginScopeCheck } from './plugins';
import { DEFAULT_SETTING_SOURCES, type SETTING_SOURCES } from '@archon/paths/skills';
import {
  ClaudeFirstEventTimeoutError,
  classifyClaudeThrownError,
  failureResultChunk,
} from './failure';
import { applyNodeConfig, isWorkflowNode } from './node-config';
import { streamClaudeMessages, type ToolResultEntry } from './stream';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.claude');
  return cachedLog;
}

function deliveredClaudeCredential(options: SendQueryOptions | undefined): string | undefined {
  return ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'].find(
    key => options?.userCredentialEnvKeys?.includes(key) && options.env?.[key]
  );
}

export function buildRequestSubprocessEnv(
  requestOptions: SendQueryOptions | undefined
): NodeJS.ProcessEnv {
  if (requestOptions?.execContext?.kind !== 'container') {
    const authMode =
      process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.CLAUDE_API_KEY ? 'explicit' : 'global';
    getLog().info(
      { authMode },
      authMode === 'global' ? 'using_global_auth' : 'using_explicit_tokens'
    );
  }
  const env = buildProviderSubprocessEnv(requestOptions);
  const delivered = deliveredClaudeCredential(requestOptions);
  if (delivered) {
    for (const key of [
      'ANTHROPIC_API_KEY',
      'CLAUDE_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_CUSTOM_HEADERS',
      'CLAUDE_CODE_API_KEY_HELPER_FD',
      'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
    ])
      delete env[key];
    env[delivered === 'CLAUDE_API_KEY' ? 'ANTHROPIC_API_KEY' : delivered] =
      requestOptions?.env?.[delivered];
    for (const key of [
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
      'CLAUDE_CODE_USE_MANTLE',
      'CLAUDE_CODE_USE_ANTHROPIC_AWS',
      'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
    ]) {
      env[key] = '0';
    }
    // Native settings env otherwise overwrites the delivered identity.
    env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1';
  } else if (env.CLAUDE_API_KEY && !env.ANTHROPIC_API_KEY && !env.CLAUDE_CODE_OAUTH_TOKEN) {
    env.ANTHROPIC_API_KEY = env.CLAUDE_API_KEY;
    getLog().debug('claude.api_key_mirrored');
  }
  // Without this, Claude Code reports some refusals to start (an invalid proxy URL, for
  // one) only on stderr and exits 1, which reads as a crashed process and is retried.
  // With it, every refusal with a known cause also ends in an error result carrying
  // `startup_failure_reason`, which classifyClaudeErrorResult turns into a failure class.
  env.CLAUDE_CODE_STARTUP_FAILURE_RESULTS = '1';
  return env;
}

/**
 * Opt the system prompt out of the SDK's recording, on by default since 0.3.267.
 * A recorded prompt is re-sent verbatim when the session is resumed, ignoring the
 * prompt passed on that request until compaction. Archon changes the prompt
 * within a session: a workflow node that resumes or forks another node's session
 * brings its own `systemPrompt`, and a chat turn's append lists the codebases
 * and workflows as they are now.
 */
export function withPerRequestSystemPrompt(
  systemPrompt: Options['systemPrompt']
): Options['systemPrompt'] {
  if (systemPrompt === undefined) return undefined;
  if (typeof systemPrompt === 'string' || Array.isArray(systemPrompt)) {
    return { type: 'custom', prompt: systemPrompt, snapshot: false };
  }
  return { ...systemPrompt, snapshot: false };
}

function getFirstEventTimeoutMs(): number {
  const raw = process.env.ARCHON_CLAUDE_FIRST_EVENT_TIMEOUT_MS;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 60_000;
}

function buildFirstEventHangDiagnostics(
  subprocessEnv: Record<string, string>,
  model: string | undefined
): Record<string, unknown> {
  return {
    subprocessEnvKeys: Object.keys(subprocessEnv),
    parentClaudeKeys: Object.keys(process.env).filter(
      k => k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k.startsWith('ANTHROPIC_')
    ),
    model,
    platform: process.platform,
    uid: getProcessUid(),
    isTTY: process.stdout.isTTY ?? false,
    claudeCode: process.env.CLAUDECODE,
    claudeCodeEntrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
  };
}

class FirstEventTimeoutError extends Error {}

/**
 * Wraps an async generator so that the first call to .next() must resolve
 * within `timeoutMs`. If it doesn't, aborts the controller and throws.
 */
export async function* withFirstMessageTimeout<T>(
  gen: AsyncGenerator<T>,
  controller: AbortController,
  timeoutMs: number,
  diagnostics: Record<string, unknown>
): AsyncGenerator<T> {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  let firstValue: IteratorResult<T>;
  try {
    firstValue = await Promise.race([
      gen.next(),
      new Promise<never>((_, reject) => {
        timerId = setTimeout(() => {
          reject(new FirstEventTimeoutError());
        }, timeoutMs);
      }),
    ]);
  } catch (err) {
    if (err instanceof FirstEventTimeoutError) {
      controller.abort();
      getLog().error({ ...diagnostics, timeoutMs }, 'claude.first_event_timeout');
      throw new ClaudeFirstEventTimeoutError(
        'Claude Code subprocess produced no output within ' +
          timeoutMs +
          'ms. ' +
          'See logs for claude.first_event_timeout diagnostic dump. ' +
          'Details: https://github.com/coleam00/Archon/issues/1067'
      );
    }
    throw err;
  } finally {
    clearTimeout(timerId);
  }

  if (firstValue.done) return;
  yield firstValue.value;
  yield* gen;
}

/**
 * Returns the current process UID, or undefined on platforms that don't support it.
 */
export function getProcessUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

// ─── Base Options Builder ────────────────────────────────────────────────

/** Bun-runnable JS extensions. `.ts`/`.tsx`/`.jsx` are excluded — the SDK has
 * never shipped those as entry points, so accepting them would only widen the
 * surface for misconfiguration. */
const BUN_JS_EXTENSIONS = ['.js', '.mjs', '.cjs'] as const;

/**
 * Decide whether the Claude subprocess should be spawned with `--no-env-file`.
 *
 * `--no-env-file` is a Bun flag (consumed by the Bun runtime, not by Claude
 * Code itself) that prevents auto-loading `.env` from the target repo cwd
 * into the spawned process. It only does anything when the SDK spawns a
 * Bun-runnable JS file via `bun cli.js …` — Bun parses the flag and skips
 * its env autoload. For native Claude Code binaries the flag is meaningless
 * and, worse, gets handed to the binary which rejects unknown options.
 *
 * The dev-mode `cliPath === undefined` path used to imply "JS executable"
 * because the SDK shipped `cli.js` inside its package. SDK 0.2.x switched
 * to per-platform native binaries (e.g. `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`),
 * so dev mode now resolves to a native executable and the historical
 * `undefined → true` heuristic is unsafe. Only return `true` when we have
 * an explicit Bun-runnable JS path (`.js`/`.mjs`/`.cjs`) — i.e. when the
 * operator pointed Archon at a legacy Bun/Node-runnable cli script.
 * Otherwise return `false`.
 *
 * Safety: target-repo `.env` leaks are prevented by `stripCwdEnv()` in
 * `@archon/paths` (#1067), which deletes CWD `.env` keys from
 * `process.env` at every Archon entry point before any subprocess is
 * spawned. The native Claude binary does not auto-load `.env` from its
 * cwd either (verified end-to-end with sentinel keys). `--no-env-file`
 * was belt-and-suspenders for the JS-via-Bun case only.
 *
 * Exported so the decision can be unit-tested without needing to mock
 * `BUNDLED_IS_BINARY` or run the full provider sendQuery pathway.
 */
export function shouldPassNoEnvFile(cliPath: string | undefined): boolean {
  if (cliPath === undefined) return false;
  return BUN_JS_EXTENSIONS.some(ext => cliPath.endsWith(ext));
}

/**
 * Build base Claude SDK options from cwd, request options, and assistant defaults.
 * Does not include nodeConfig translation — that is handled by applyNodeConfig.
 */
function buildBaseClaudeOptions(
  cwd: string,
  requestOptions: SendQueryOptions | undefined,
  assistantDefaults: ReturnType<typeof parseClaudeConfig>,
  controller: AbortController,
  stderrLines: string[],
  toolResultQueue: ToolResultEntry[],
  env: NodeJS.ProcessEnv,
  cliPath: string | undefined,
  settingSources: (typeof SETTING_SOURCES)[number][]
): Options {
  const isJsExecutable = shouldPassNoEnvFile(cliPath);
  getLog().debug({ cliPath: cliPath ?? null, isJsExecutable }, 'claude.subprocess_env_file_flag');

  // The SDK resolves a native host binary before calling the spawn hook unless
  // an executable path is supplied. This placeholder is never executed: the
  // container hook ignores the SDK command and uses the runner image's Claude.
  const containerExecContext =
    requestOptions?.execContext?.kind === 'container' ? requestOptions.execContext : undefined;
  const spawnOverride = containerExecContext
    ? {
        pathToClaudeCodeExecutable: 'claude',
        spawnClaudeCodeProcess: buildContainerSpawn(containerExecContext),
      }
    : {};

  return {
    cwd,
    // In compiled binaries, the resolver supplies an absolute executable path;
    // in dev mode it returns undefined and the SDK resolves from node_modules.
    ...(cliPath !== undefined && containerExecContext === undefined
      ? { pathToClaudeCodeExecutable: cliPath }
      : {}),
    ...(isJsExecutable && containerExecContext === undefined
      ? { executableArgs: ['--no-env-file'] }
      : {}),
    ...spawnOverride,
    env,
    model: requestOptions?.model ?? assistantDefaults.model,
    abortController: controller,
    ...(requestOptions?.outputFormat !== undefined
      ? { outputFormat: requestOptions.outputFormat }
      : {}),
    ...(requestOptions?.maxBudgetUsd !== undefined
      ? { maxBudgetUsd: requestOptions.maxBudgetUsd }
      : {}),
    ...(requestOptions?.fallbackModel !== undefined
      ? { fallbackModel: requestOptions.fallbackModel }
      : {}),
    ...(requestOptions?.forkSession !== undefined
      ? { forkSession: requestOptions.forkSession }
      : {}),
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    systemPrompt: requestOptions?.systemPrompt ?? {
      type: 'preset',
      preset: 'claude_code',
      ...(requestOptions?.appendSystemPrompt !== undefined
        ? { append: requestOptions.appendSystemPrompt }
        : {}),
    },
    // Per-node override wins over the assistant-level default; the final
    // fallback is DEFAULT_SETTING_SOURCES (the SDK-loading default Archon ships).
    settingSources,
    // Opt into the SDK's hook lifecycle frames so that tool-scoped hooks
    // (PreToolUse / PostToolUse / Stop / etc.) reach the workflow audit
    // stream as `hook` events (#2324). SessionStart and Setup remain
    // emitted regardless. The provider maps the SDK's `hook_started` and
    // `hook_response`; the third subtype the SDK
    // enables (`hook_progress`) falls through — it is only emitted for
    // async hooks, which Archon does not register today.
    includeHookEvents: true,
    hooks: buildToolCaptureHooks(toolResultQueue),
    stderr: (data: string): void => {
      const output = data.trim();
      if (!output) return;
      stderrLines.push(output);

      const isError =
        output.toLowerCase().includes('error') ||
        output.toLowerCase().includes('fatal') ||
        output.toLowerCase().includes('failed') ||
        output.toLowerCase().includes('exception') ||
        output.includes('at ') ||
        output.includes('Error:');

      const isInfoMessage =
        output.includes('Spawning Claude Code') ||
        output.includes('--output-format') ||
        output.includes('--permission-mode');

      if (isError && !isInfoMessage) {
        getLog().error({ stderr: output }, 'subprocess_error');
      }
    },
  };
}

// ─── Tool Capture Hooks ──────────────────────────────────────────────────

/**
 * Build SDK hooks that capture tool use results into a shared queue.
 * The queue is drained during stream normalization.
 */
function buildToolCaptureHooks(toolResultQueue: ToolResultEntry[]): Options['hooks'] {
  return {
    PostToolUse: [
      {
        hooks: [
          (async (input: PostToolUseHookInput): Promise<{ continue: true }> => {
            try {
              const response = input.tool_response;
              const text = typeof response === 'string' ? response : JSON.stringify(response ?? '');
              const update: ToolResultEntry = {
                type: 'tool_call_update',
                toolCallId: input.tool_use_id,
                status: 'completed',
                ...truncateToolOutput(text),
              };
              toolResultQueue.push(update);
            } catch (e) {
              getLog().error({ err: e, input }, 'claude.post_tool_use_hook_error');
            }
            return { continue: true };
          }) as HookCallback,
        ],
      },
    ],
    PostToolUseFailure: [
      {
        hooks: [
          (async (input: PostToolUseFailureHookInput): Promise<{ continue: true }> => {
            try {
              const update: ToolResultEntry = {
                type: 'tool_call_update',
                toolCallId: input.tool_use_id,
                status: input.is_interrupt === true ? 'cancelled' : 'failed',
                ...truncateToolOutput(input.error),
              };
              toolResultQueue.push(update);
            } catch (e) {
              getLog().error({ err: e, input }, 'claude.post_tool_use_failure_hook_error');
            }
            return { continue: true };
          }) as HookCallback,
        ],
      },
    ],
  };
}

/** The per-query state the SDK options write into. */
interface QueryRun {
  controller: AbortController;
  stderrLines: string[];
  toolResultQueue: ToolResultEntry[];
}

/**
 * The SDK options for one query: base options, the node's config, delivered
 * credentials, native tools and the resume target. Yields the node config's warnings.
 */
async function* buildQueryOptions(
  cwd: string,
  resumeSessionId: string | undefined,
  requestOptions: SendQueryOptions | undefined,
  run: QueryRun
): AsyncGenerator<MessageChunk, { options: Options; env: NodeJS.ProcessEnv }> {
  const isContainerRun = requestOptions?.execContext?.kind === 'container';
  const assistantDefaults = parseClaudeConfig(requestOptions?.assistantConfig ?? {});

  // Container runs use the runner image's Claude, so never resolve a host binary.
  const resolvedCliPath = isContainerRun
    ? undefined
    : await resolveClaudeBinaryPath(assistantDefaults.claudeBinaryPath);

  // A container run gets ONLY the Archon-managed bag + a minimal base — host
  // process.env never crosses the boundary (the isolation invariant); the host
  // path inherits the (already-cleaned) process env.
  const env = buildRequestSubprocessEnv(requestOptions);
  // Ask the CLI for its session-state events: `idle` is what tells a finished turn
  // from a result that arrived while background agents still run.
  env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = '1';
  const settingSources =
    requestOptions?.nodeConfig?.settingSources ??
    assistantDefaults.settingSources ??
    DEFAULT_SETTING_SOURCES;

  const options = buildBaseClaudeOptions(
    cwd,
    requestOptions,
    assistantDefaults,
    run.controller,
    run.stderrLines,
    run.toolResultQueue,
    env,
    resolvedCliPath,
    [...settingSources]
  );

  if (requestOptions?.nodeConfig) {
    const skillSearch = {
      env,
      includeProject: settingSources.includes('project'),
      includeUser: !isContainerRun && settingSources.includes('user'),
      isContainer: isContainerRun,
    };
    const nodeConfigWarnings = await applyNodeConfig(
      options,
      requestOptions.nodeConfig,
      cwd,
      skillSearch,
      () =>
        readClaudePluginIds(
          buildPluginListCommand({
            cliPath: resolvedCliPath,
            cwd,
            env,
            execContext: requestOptions.execContext,
          })
        )
    );
    for (const warning of nodeConfigWarnings) {
      yield { type: 'warning', ...warning };
    }
  }

  if (deliveredClaudeCredential(requestOptions)) {
    options.settings = {
      ...(typeof options.settings === 'object' ? options.settings : {}),
      apiKeyHelper: '',
    };
  }
  options.systemPrompt = withPerRequestSystemPrompt(options.systemPrompt);

  if (requestOptions?.nativeTools && requestOptions.nativeTools.length > 0) {
    registerNativeTools(options, requestOptions.nativeTools);
  }
  setResumeTarget(options, cwd, resumeSessionId, requestOptions?.forkSession);
  return { options, env };
}

/**
 * Register in-process native tools (e.g. manage_run) as an archon MCP server,
 * mirroring the file-based mcp branch. Merge so a nodeConfig mcp config and
 * native tools can coexist.
 */
function registerNativeTools(
  options: Options,
  nativeTools: NonNullable<SendQueryOptions['nativeTools']>
): void {
  const server = buildArchonMcpServer(nativeTools);
  options.mcpServers = { ...(options.mcpServers ?? {}), [ARCHON_TOOL_SERVER]: server };
  options.allowedTools = [...(options.allowedTools ?? []), `mcp__${ARCHON_TOOL_SERVER}__*`];
  getLog().info({ count: nativeTools.length }, 'claude.native_tools_registered');
}

function setResumeTarget(
  options: Options,
  cwd: string,
  resumeSessionId: string | undefined,
  forkSession: boolean | undefined
): void {
  if (resumeSessionId) {
    options.resume = resumeSessionId;
    getLog().debug(
      { sessionIdPreview: sessionPreview(resumeSessionId), forkSession },
      'resuming_session'
    );
  } else {
    getLog().debug({ cwd }, 'starting_new_session');
  }
}

function trackSubtask(
  openSubtaskIds: Set<string>,
  chunk: Extract<MessageChunk, { type: 'subtask' }>
): void {
  if (chunk.status === 'started' || chunk.status === 'running') openSubtaskIds.add(chunk.taskId);
  else openSubtaskIds.delete(chunk.taskId);
}

const nativeHelperSettingsSchema = z.object({
  response: z.object({
    effective: z.object({
      apiKeyHelper: z.string().min(1),
      env: z.record(z.string(), z.string()).optional(),
    }),
  }),
});

async function checkNativeKeyHelper(
  session: ReturnType<typeof query>,
  request: Parameters<IAgentProvider['checkCredential']>[0],
  subprocessEnv: NodeJS.ProcessEnv
): Promise<CredentialStatus> {
  // accountInfo reports a configured helper even when it fails. Read the native
  // get_settings control response so policy and subprocess env use the same cascade;
  // the host-side resolveSettings API cannot accept the subprocess environment.
  if (!('request' in session) || typeof session.request !== 'function')
    throw new Error('Claude SDK cannot inspect the native apiKeyHelper settings');
  const settings = nativeHelperSettingsSchema.parse(
    await session.request({ subtype: 'get_settings' })
  ).response.effective;
  const env = { ...subprocessEnv, ...settings.env };
  if (env.ANTHROPIC_API_KEY || env.CLAUDE_API_KEY || env.ANTHROPIC_AUTH_TOKEN)
    return { state: 'usable', source: 'native' };
  return await new Promise<CredentialStatus>((resolve, reject) => {
    const onResult = (error: ExecFileException | null, stdout: string): void => {
      if (request.signal.aborted) {
        reject(request.signal.reason);
      } else if (error) {
        resolve({
          state: 'unusable',
          source: 'native',
          evidence: `apiKeyHelper failed (${error.code ?? error.name})`,
        });
      } else if (!stdout.trim()) {
        resolve({
          state: 'unusable',
          source: 'native',
          evidence: 'apiKeyHelper returned no credential',
        });
      } else {
        resolve({ state: 'usable', source: 'native' });
      }
    };
    if (request.execContext?.kind === 'container') {
      // The runner image can supply a key the forwarded env never saw; Claude in the
      // runner uses it, so the helper matters only when the runner has none.
      execFile(
        'docker',
        [
          ...buildDockerExecPrefix(request.execContext, request.cwd, env),
          'sh',
          '-c',
          'if [ -n "$ANTHROPIC_API_KEY$ANTHROPIC_AUTH_TOKEN" ]; then echo runner-env; else exec sh -c "$1"; fi',
          'check-credential',
          settings.apiKeyHelper,
        ],
        { signal: request.signal },
        onResult
      );
    } else {
      exec(settings.apiKeyHelper, { cwd: request.cwd, env, signal: request.signal }, onResult);
    }
  });
}

// ─── Claude Provider ───────────────────────────────────────────────────────

/**
 * Claude AI agent provider.
 * Implements IAgentProvider with full SDK integration.
 *
 * sendQuery orchestrates the following internal helpers:
 * - buildQueryOptions: SDK option construction, including applyNodeConfig
 *   (./node-config.ts) for workflow nodeConfig → SDK options + warnings
 * - streamClaudeMessages (./stream.ts): raw SDK event normalization into MessageChunks
 * - classifyClaudeThrownError (./failure.ts): typed failure for an error thrown by the SDK
 */
export class ClaudeProvider implements IAgentProvider {
  async diagnose(
    request: Parameters<NonNullable<IAgentProvider['diagnose']>>[0]
  ): Promise<ProviderDiagnostics> {
    const config = parseClaudeConfig(request.assistantConfig ?? {});
    return diagnoseBinary(
      'claude-binary',
      'Claude binary',
      () => resolveClaudeBinaryWithSource(config.claudeBinaryPath),
      request.signal
    );
  }

  async checkCredential(
    request: Parameters<IAgentProvider['checkCredential']>[0]
  ): Promise<CredentialStatus> {
    const config = parseClaudeConfig(request.assistantConfig ?? {});
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal.addEventListener('abort', abort, { once: true });
    let session: ReturnType<typeof query> | undefined;
    let closeInput: (() => void) | undefined;
    let subprocessEnv: NodeJS.ProcessEnv | undefined;
    try {
      request.signal.throwIfAborted();
      // Keep input open for control requests without sending a model prompt.
      session = query({
        prompt: (async function* () {
          await new Promise<void>(resolve => {
            closeInput = resolve;
          });
        })(),
        options: {
          env: buildRequestSubprocessEnv(request),
          pathToClaudeCodeExecutable:
            request.execContext?.kind === 'container'
              ? 'claude'
              : await resolveClaudeBinaryPath(config.claudeBinaryPath),
          spawnClaudeCodeProcess: options => {
            // Capture the SDK's final environment rather than duplicating its transforms.
            subprocessEnv = options.env;
            if (request.execContext?.kind === 'container')
              return buildContainerSpawn(request.execContext)(options);
            const child = spawn(options.command, options.args, {
              cwd: options.cwd,
              env: options.env,
              signal: options.signal,
              windowsHide: true,
              stdio: ['pipe', 'pipe', 'pipe'],
            });
            child.stderr.resume();
            return child;
          },
          cwd: request.cwd,
          settingSources: request.settingSources ??
            config.settingSources ?? [...DEFAULT_SETTING_SOURCES],
          abortController: controller,
          tools: [],
          mcpServers: {},
          strictMcpConfig: true,
          plugins: [],
        },
      });
      const account = await session.accountInfo();
      request.signal.throwIfAborted();
      // Cloud backends resolve credentials outside Claude's first-party account store.
      if (account.apiProvider && account.apiProvider !== 'firstParty')
        return { state: 'not_checked', source: 'native' };
      if (account.apiKeySource === 'apiKeyHelper' || account.tokenSource === 'apiKeyHelper') {
        if (!subprocessEnv) throw new Error('Claude SDK did not expose its subprocess environment');
        return await checkNativeKeyHelper(session, request, subprocessEnv);
      }
      const hasCredential = [account.tokenSource, account.apiKeySource].some(
        source => source && source !== 'none'
      );
      return { state: hasCredential ? 'usable' : 'not_connected', source: 'native' };
    } catch (error) {
      request.signal.throwIfAborted();
      return {
        state: 'check_failed',
        source: 'native',
        evidence:
          redactCredentialValues(
            error instanceof Error ? error.message : String(error),
            collectCredentialValues({ ...process.env, ...request.env })
          ) || 'Claude account check failed',
      };
    } finally {
      closeInput?.();
      session?.close();
      controller.abort();
      request.signal.removeEventListener('abort', abort);
    }
  }

  constructor() {
    if (getProcessUid() === 0 && process.env.IS_SANDBOX !== '1') {
      throw new Error(
        'Claude Code SDK does not support bypassPermissions when running as root (UID 0). ' +
          'Run as a non-root user, set IS_SANDBOX=1, or use the Dockerfile which creates a non-root appuser.'
      );
    }
  }

  getCapabilities(): ProviderCapabilities {
    return CLAUDE_CAPABILITIES;
  }

  /**
   * Send a query to Claude and stream responses. One call is one SDK query: a failure
   * ends in a `result` carrying a typed `failure`, and the engine decides whether to
   * try again. Observed completion ends in `settled`. Cancellation throws; lost observation does not settle.
   */
  // No security gate lives here on purpose. Env hygiene for a target repo is
  // structural (the platform strips what must not reach a subprocess before a
  // provider runs), so a provider that scanned or refused would be a second,
  // divergent copy of that policy.
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const isContainerRun = requestOptions?.execContext?.kind === 'container';
    const stderrLines: string[] = [];
    const controller = new AbortController();
    const onAbort = (): void => {
      controller.abort();
    };
    if (requestOptions?.abortSignal) {
      requestOptions.abortSignal.addEventListener('abort', onAbort, { once: true });
    }
    let resultReported = false;
    let closeInput: (() => void) | undefined;
    const openSubtaskIds = new Set<string>();

    try {
      if (requestOptions?.abortSignal?.aborted) {
        throw new Error('Query aborted');
      }
      const toolResultQueue: ToolResultEntry[] = [];
      const { options, env } = yield* buildQueryOptions(cwd, resumeSessionId, requestOptions, {
        controller,
        stderrLines,
        toolResultQueue,
      });

      const { promise: inputClosed, resolve: finishInput } = Promise.withResolvers<undefined>();
      closeInput = (): void => {
        finishInput(undefined);
      };
      controller.signal.addEventListener('abort', closeInput, { once: true });
      async function* input(): AsyncGenerator<SDKUserMessage> {
        yield {
          type: 'user',
          message: { role: 'user', content: prompt },
          parent_tool_use_id: null,
          session_id: resumeSessionId ?? '',
        };
        await inputClosed;
      }
      const spendBaseline = await readSessionSpendBaseline(resumeSessionId, {
        cwd,
        env,
        execContext: requestOptions?.execContext,
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      const rawEvents = query({ prompt: input(), options });
      const diagnostics = buildFirstEventHangDiagnostics(
        options.env as Record<string, string>,
        options.model
      );
      const nodeConfig = requestOptions?.nodeConfig;
      const events = withFirstMessageTimeout(
        isWorkflowNode(nodeConfig)
          ? withPluginScopeCheck(rawEvents, nodeConfig.plugins ?? [])
          : rawEvents,
        controller,
        getFirstEventTimeoutMs(),
        diagnostics
      );

      // Claude resumes-or-errors: an invalid resume id fails the turn, so reaching
      // the result stream means the prior session was restored. Hence `true`
      // whenever a resume was requested.
      for await (const chunk of withResumedOutcome(
        closeOpenToolCalls(
          streamClaudeMessages(events, toolResultQueue, spendBaseline, closeInput),
          // A result can arrive while background agents still run their tools.
          { resultEndsTurn: false }
        ),
        resumedOutcome(resumeSessionId, true)
      )) {
        if (chunk.type === 'result') resultReported = true;
        else if (chunk.type === 'subtask') trackSubtask(openSubtaskIds, chunk);
        yield chunk;
      }
    } catch (error) {
      const err = error as Error;
      // Cancellation is not a failure: the caller asked for it and already knows.
      // The first-event timeout aborts the same controller, so it is told apart by type.
      if (
        requestOptions?.abortSignal?.aborted === true ||
        (controller.signal.aborted && !(err instanceof ClaudeFirstEventTimeoutError))
      ) {
        throw new Error('Query aborted');
      }
      const stderr = stderrLines.join('\n');
      const failure = classifyClaudeThrownError(err, stderr, isContainerRun ? undefined : cwd);
      getLog().error(
        { err, stderrContext: stderr, failureClass: failure.class, resultReported },
        'query_error'
      );
      // Lost observation of live work belongs to the engine's unsettled-stream
      // failure, which names the tasks. Keep the vendor evidence in the log above.
      if (!resultReported && openSubtaskIds.size === 0) {
        resultReported = true;
        yield failureResultChunk(failure);
        yield { type: 'settled' };
      }
    } finally {
      closeInput?.();
      if (closeInput) controller.signal.removeEventListener('abort', closeInput);
      requestOptions?.abortSignal?.removeEventListener('abort', onAbort);
    }
  }

  getType(): string {
    return 'claude';
  }
}
