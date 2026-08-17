/**
 * AiderDesk provider — implements IAgentProvider by wrapping AiderDesk's REST API.
 *
 * Architecture:
 * - AiderDesk runs on the host at localhost:24337 (or via Docker bridge gateway
 *   at 172.18.0.1:24337 when Archon runs in a container).
 * - The provider creates/resumes AiderDesk tasks, binds a name-keyed agent
 *   profile via `POST /api/project/tasks {updates:{agentProfileId, mainModel,
 *   currentMode, workingMode}}`, then opens a streaming `POST /api/run-prompt`
 *   with `Accept: text/event-stream` and forwards parsed SSE frames as
 *   MessageChunks.
 * - No SDK subprocess — pure HTTP via the injectable AiderDeskClient.
 * - Session resume: AiderDesk tasks persist their conversation; resume by
 *   loading the task ID.
 *
 * Resolution contract (the new strict profile-key model):
 *   - `requestOptions.model` is the agent-profile NAME (case-sensitive).
 *   - `SendQueryOptions.modelOverride` is the OPTIONAL inference-endpoint
 *     literal passed as `mainModel` on the updateTask body (e.g.
 *     `poe/minimax-m3`, `ollama/internlm/internlm2.5:7b-8k`). When unset,
 *     `mainModel` is OMITTED and AiderDesk uses the profile's default model.
 *   - `assistantConfig.agentProfileId` may hard-pin the profile UUID; it
 *     wins over the catalog lookup when both are present (operator pin).
 *   - No match → throw `UnknownAiderDeskAgentProfileError(name, knownNames,
 *     nearestCandidates)`. NEVER fallback to a default.
 *
 * sendQuery() flow (bind-then-stream, issue: empty handshake on unbound task):
 *   1. Parse config (defensive, never throws).
 *   2. Resolve API URL (env → Docker detection → localhost).
 *   3. Translate cwd → projectDir (translateProjectDir from this same file).
 *   4. Create or resume an AiderDesk task.
 *   5. RESOLVE profile: explicit assistantConfig.agentProfileId pin OR case-
 *      sensitive match against `/api/agent-profiles` by name. NO match →
 *      throw typed error.
 *   6. RESOLVE modelOverride (if set): case-sensitive match against
 *      `/api/models` entries joined as `<providerId>/<id>`. NO match → throw
 *      typed error.
 *   7. BIND agentProfileId + (optional) mainModel/currentMode/workingMode via
 *      /api/project/tasks. For fresh tasks a bind failure is fatal; for resumed
 *      tasks we tolerate bind failure (the prior run already bound).
 *   8. Apply output_format prompt augmentation (best-effort JSON Schema path).
 *   9. Stream SSE frames from /api/run-prompt and dispatch each `kind` onto
 *      the IAProvider chunk shape.
 *  10. Yield final result chunk with sessionId, stopReason, resolved model.
 *  11. Stamp `resumed` via withResumedOutcome for resume reporting.
 */
import { createLogger } from '@archon/paths';
import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
} from '../../types';
import { withResumedOutcome, resumedOutcome } from '../../shared/resumed';
import {
  augmentPromptForJsonSchema,
  tryParseStructuredOutput,
} from '../../shared/structured-output';
import { AIDERDESK_CAPABILITIES } from './capabilities';
import { parseAiderdeskConfig } from './config';
import { AiderDeskClient, resolveDefaultApiUrl, type FetchFn } from './client';
import {
  AiderDeskApiError,
  classifyAiderdeskError,
  errorMessage,
  InvalidAiderDeskModelOverrideError,
  UnknownAiderDeskAgentProfileError,
} from './errors';
import { nearestNames } from './profile-matcher';
import type {
  AiderDeskModel,
  AiderDeskProfile,
  AiderDeskProjectDirRemap,
  AiderDeskTaskState,
  AiderDeskTaskUpdate,
} from './types';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.aiderdesk');
  return cachedLog;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 300_000; // 5 minutes — caps a single stream

/**
 * TTL for the per-instance /api/agent-profiles and /api/models caches.
 * 60s — long enough to absorb burst traffic inside a single workflow, short
 * enough that newly-registered AiderDesk agents / pulled models become
 * available with a tolerable delay.
 */
const CATALOG_TTL_MS = 60_000;

/**
 * Parse a JSON-shaped `AIDERDESK_PROJECT_DIR_REMAP` env value into a typed
 * remap. Validates that the supplied JSON object / array conforms to the
 * supported shapes (object form `{ "<regex>": "<replacement>" }`, or array
 * form `Array<{ from, to }>`). On a parse error returns `{ remap: null,
 * warn: <human-readable chunk text> }` so the caller can yield a single
 * `system` chunk and continue with the identity mapping — never throw.
 *
 *   - Object form: longest-matching KEY wins. Among keys of equal length,
 *     insertion order is preserved (JS `Object.entries` is well-defined for
 *     string keys since ES2015).
 *   - Array form: declaration order; first matching entry wins.
 *
 * Keys compile as JavaScript RegExp sources on the way through the matcher,
 * so operators can write anchors (`^/host/projects/`) to constrain where in
 * the path the match fires.
 */
function parseProjectDirRemapJson(
  raw: string | undefined
): { remap: AiderDeskProjectDirRemap | null; warn: string | null } {
  if (raw == null || raw === '') return { remap: null, warn: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const truncated = raw.length > 90 ? `${raw.slice(0, 90)}…` : raw;
    return {
      remap: null,
      warn:
        `⚠️ AiderDesk projectDir-remap env is not valid JSON: ${truncated} ` +
        `(${reason}). Supported shapes — object: ` +
        `'{"<regex>":"<replacement>"}', or array: '[{"from":"<regex>","to":"<replacement>"}]'. ` +
        `Continuing with the identity (no remap) mapping.`,
    };
  }

  if (Array.isArray(parsed)) {
    const out: { from: string; to: string }[] = [];
    for (const entry of parsed) {
      if (
        entry &&
        typeof entry === 'object' &&
        typeof (entry as { from?: unknown }).from === 'string' &&
        typeof (entry as { to?: unknown }).to === 'string'
      ) {
        out.push({
          from: (entry as { from: string }).from,
          to: (entry as { to: string }).to,
        });
      }
    }
    return out.length > 0 ? { remap: out, warn: null } : { remap: null, warn: null };
  }

  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof k === 'string' && k.length > 0 && typeof v === 'string') {
        out[k] = v;
      }
    }
    return Object.keys(out).length > 0
      ? { remap: out, warn: null }
      : { remap: null, warn: null };
  }

  return {
    remap: null,
    warn:
      `⚠️ AiderDesk projectDir-remap env has unsupported top-level type (got ${typeof parsed}); ` +
      `expected a JSON object '{\"<regex>\":\"<replacement>\"}' or a JSON array '[{\"from\":\"<regex>\",\"to\":\"<replacement>\"}]'. ` +
      `Continuing with the identity (no remap) mapping.`,
  };
}

/**
 * Apply the resolved projectDir remap to a raw cwd.
 *
 * Deterministic + side-effect-free with one exception: emits a structured
 * `log.debug({ from, to, source }, 'aiderdesk.projectDir_remapped')` whenever
 * a remap fires, so an operator can grep the archon container log to confirm
 * the translator took effect (`aiderdesk.projectDir_remapped` is the agreed
 * marker). The line is emitted at debug-level only — never warn/error/info.
 *
 * Returns `cwd` verbatim when no remap is configured, when no entry matches,
 * or when every candidate entry has an invalid regex (a defensive skip —
 * matches a malformed YAML/JSON entry would crash the workflow otherwise).
 *
 * Precedence of the remap is NOT this function's responsibility — the
 * provider resolves `requestOptions.env > process.env > assistantConfig`
 * BEFORE calling here, passing only the effective { remap, source } pair.
 */
export function translateProjectDir(
  cwd: string,
  opts?: { remap?: AiderDeskProjectDirRemap | null; source?: string }
): string {
  const remap = opts?.remap;
  if (!remap) return cwd;

  const source = opts?.source;

  // Array form: declaration-order, first match wins.
  if (Array.isArray(remap)) {
    for (const entry of remap) {
      if (!entry || typeof entry.from !== 'string' || typeof entry.to !== 'string') {
        continue;
      }
      try {
        const matcher = new RegExp(entry.from);
        if (matcher.test(cwd)) {
          const translated = cwd.replace(new RegExp(entry.from), entry.to);
          getLog().debug(
            { from: entry.from, to: entry.to, source },
            'aiderdesk.projectDir_remapped'
          );
          return translated;
        }
      } catch {
        // Bad RegExp source on this entry — silently skip and try the next.
        continue;
      }
    }
    return cwd;
  }

  // Object form: longest-matching KEY wins. Length-sort gives that for free;
  // ties fall back to insertion order via `Array.prototype.sort` stability
  // (engines that ignore ES2019 stability still preserve insertion order on
  // equal-length comparisons in practice for `Object.entries`).
  const entries = Object.entries(remap)
    .filter(
      (pair): pair is [string, string] =>
        typeof pair[0] === 'string' &&
        pair[0].length > 0 &&
        typeof pair[1] === 'string'
    )
    .sort((a, b) => b[0].length - a[0].length);

  for (const [from, to] of entries) {
    try {
      const re = new RegExp(from);
      if (re.test(cwd)) {
        const translated = cwd.replace(re, to);
        getLog().debug({ from, to, source }, 'aiderdesk.projectDir_remapped');
        return translated;
      }
    } catch {
      // Bad RegExp source on this entry — silently skip and try the next.
      continue;
    }
  }

  return cwd;
}

/**
 * Build the AiderDesk `mainModel` literal form from a `/api/models` entry:
 * `<providerId>/<id>`. This matches AiderDesk's contract — the `mainModel`
 * field on the task update is a `<provider>/<model>` literal, never a bare
 * model id.
 */
function joinModelRef(m: AiderDeskModel): string {
  return `${m.providerId}/${m.id}`;
}

/**
 * AiderDesk provider implementation.
 *
 * Wraps AiderDesk's REST API to implement the IAgentProvider contract.
 * Any `prompt:` node in a workflow YAML can use `provider: aiderdesk`
 * declaratively.
 */
export class AiderDeskProvider implements IAgentProvider {
  private readonly fetchFn: FetchFn | undefined;
  /**
   * Per-instance cache of GET /api/agent-profiles. The cache is implicitly
   * keyed by `(client + projectDir)` because every `sendQuery` constructs a
   * fresh `AiderDeskClient`, so the cache is effectively per-provider-instance.
   *
   * TTL is 60s — checked lazily on every read against `Date.now()`. No timer,
   * no eviction callback, no manual reset.
   */
  private agentProfilesCache: { agents: AiderDeskProfile[]; fetchedAt: number } | null = null;
  /**
   * Per-instance cache of GET /api/models — same TTL + lazy-eval policy as
   * `agentProfilesCache`. Holds the JOINED `<providerId>/<id>` strings ready
   * for `mainModel` validation.
   */
  private modelsCache: { models: string[]; fetchedAt: number } | null = null;

  constructor(options?: { fetchFn?: FetchFn }) {
    this.fetchFn = options?.fetchFn;
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const log = getLog();
    const abortSignal = requestOptions?.abortSignal;

    // ── 1. Parse config ──────────────────────────────────────────────────
    const assistantConfig = requestOptions?.assistantConfig
      ? parseAiderdeskConfig(requestOptions.assistantConfig)
      : {};

    // ── 1a. Translate cwd → projectDir ───────────────────────────────────
    // AiderDesk runs on the HOST filesystem and autodetects every task as
    // `<projectDir>/.aider-desk/`. When archon runs in a container it binds
    // the conversation cwd to a CONTAINER-internal path (e.g.
    // `/host/projects/orchestration-home` through the bind mount, or `/app`
    // for engine-code-local work) that does not exist on the host — AiderDesk
    // tries to mkdir there, gets EACCES, and the run-prompt SSE stream
    // returns content="" (the 14-s empty-handshake signature archon reports
    // as `dag.node_empty_output`).
    //
    // We translate BEFORE any AiderDeskClient call. The effective remap is
    // resolved at the highest-precedence source first:
    //   requestOptions.env > process.env > assistantConfig > identity.
    // Raw env strings are parsed here once; the remap shape can be either
    // (a) an object `{"<regex>":"<replacement>"}` (longest-key wins) or
    // (b) an array  `[{"from":"<regex>","to":"<replacement>"}]` (declaration
    // order, first match wins). Identical shapes inside the YAML-declared
    // `assistantConfig.projectDirRemap`.
    const envRemapRaw =
      requestOptions?.env?.AIDERDESK_PROJECT_DIR_REMAP ??
      process.env.AIDERDESK_PROJECT_DIR_REMAP;
    const envRemapParsed = parseProjectDirRemapJson(envRemapRaw);
    if (envRemapParsed.warn) {
      // JSON parse failed — surface as exactly one system chunk and continue
      // with the identity mapping. Workflow MUST not crash on a misconfig.
      yield { type: 'system', content: envRemapParsed.warn };
    }
    const effectiveRemap =
      envRemapParsed.remap !== null
        ? envRemapParsed.remap
        : assistantConfig.projectDirRemap;
    const remapSource =
      envRemapParsed.remap !== null
        ? requestOptions?.env?.AIDERDESK_PROJECT_DIR_REMAP != null
          ? 'requestOptions.env'
          : 'process.env'
        : assistantConfig.projectDirRemap
          ? 'assistantConfig'
          : undefined;
    const projectDir = translateProjectDir(cwd, {
      remap: effectiveRemap,
      source: remapSource,
    });

    // ── 2. Resolve API URL ───────────────────────────────────────────────
    const apiUrl =
      requestOptions?.env?.AIDERDESK_API_URL ??
      process.env.AIDERDESK_API_URL ??
      assistantConfig.apiUrl ??
      resolveDefaultApiUrl();

    const requestTimeoutMs = assistantConfig.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    // ── 3. Create client ─────────────────────────────────────────────────
    const client = new AiderDeskClient({
      apiUrl,
      fetchFn: this.fetchFn,
      // AiderDesk uses no auth today; the client falls back to env if set.
      apiKey: requestOptions?.env?.AIDERDESK_API_KEY ?? process.env.AIDERDESK_API_KEY,
      timeoutMs: requestTimeoutMs,
    });

    // ── 4. Resolve task (create or resume) ────────────────────────────────
    let taskId: string;
    let resumeSucceeded = false;
    let lastSeenTaskState: AiderDeskTaskState | undefined;

    try {
      if (resumeSessionId) {
        try {
          const task = await client.loadTask(projectDir, resumeSessionId);
          taskId = task.id;
          lastSeenTaskState = task.state;
          resumeSucceeded = true;
          log.info({ taskId, state: task.state }, 'aiderdesk.task_resumed');
        } catch (error) {
          log.warn({ error: errorMessage(error), resumeSessionId }, 'aiderdesk.resume_failed');
          yield {
            type: 'system',
            content: '⚠️ Could not resume AiderDesk session; starting fresh conversation.',
          };
          const newTask = await client.createTask(projectDir);
          taskId = newTask.id;
          lastSeenTaskState = newTask.state;
        }
      } else {
        const newTask = await client.createTask(projectDir);
        taskId = newTask.id;
        lastSeenTaskState = newTask.state;
        log.info({ taskId }, 'aiderdesk.task_created');
      }
    } catch (error) {
      const aborted = abortSignal?.aborted ?? false;
      const errorClass = classifyAiderdeskError(error, aborted);
      log.error({ error: errorMessage(error), errorClass }, 'aiderdesk.task_acquisition_failed');
      yield {
        type: 'system',
        content: `⚠️ AiderDesk task acquisition failed (${errorClass}): ${errorMessage(error)}`,
      };
      yield {
        type: 'result',
        isError: true,
        errors: [errorMessage(error)],
        resumed: resumedOutcome(resumeSessionId, false),
      };
      return;
    }

    // ── 5. RESOLVE agent profile ─────────────────────────────────────────
    // The strict contract: `requestOptions.model` is a profile-name literal.
    // If absent AND no assistant pin → hard error. If present AND no catalog
    // hit → hard error with did-you-mean candidates. The exact-match on
    // profile `.name` is BY DESIGN case-sensitive; the contract is the
    // operator-facing YAML.
    //
    // The catalog fetch is forced for fresh (non-resume) calls so that every
    // request sees the current registry. On resume we skip the catalog
    // entirely when the prior task is bound to a non-empty model — the
    // resume branch already has its state.
    let resolvedProfile: AiderDeskProfile | null = null;
    let resolvedAgentId: string | null = null;

    if (assistantConfig.agentProfileId) {
      // Explicit pin — skip the catalog fetch entirely (preserved contract).
      resolvedAgentId = assistantConfig.agentProfileId;
    } else {
      // Catalog lookup — for fresh tasks we always read; for resumed tasks
      // we still read so an exact-match by name is deterministic (the
      // resumed task's existing binding does NOT influence name resolution
      // because the contract says `model` IS the name).
      const catalogAgents = await this.getCachedAgents(client);
      const requestedName = requestOptions?.model;
      if (!requestedName || typeof requestedName !== 'string') {
        // No name supplied + no pin → hard error.
        const knownNames = catalogAgents.map(a => a.name);
        throw new UnknownAiderDeskAgentProfileError(
          '',
          knownNames,
          nearestNames('', knownNames)
        );
      }
      const exact = catalogAgents.find(a => a.name === requestedName);
      if (!exact) {
        const knownNames = catalogAgents.map(a => a.name);
        throw new UnknownAiderDeskAgentProfileError(
          requestedName,
          knownNames,
          nearestNames(requestedName, knownNames)
        );
      }
      resolvedProfile = exact;
      resolvedAgentId = exact.id;
    }

    // ── 6. RESOLVE modelOverride (if any) ────────────────────────────────
    // `modelOverride` is the new sibling field on SendQueryOptions. When set,
    // it MUST match a `<providerId>/<id>` literal returned by /api/models.
    // Unset → omit `mainModel` on the updateTask body entirely; AiderDesk
    // uses the profile's default model.
    let resolvedMainModel: string | undefined;
    if (requestOptions?.modelOverride !== undefined) {
      const override = requestOptions.modelOverride;
      if (typeof override !== 'string' || override.length === 0) {
        throw new InvalidAiderDeskModelOverrideError(String(override), []);
      }
      const catalogModels = await this.getCachedModels(client);
      // Strict-match the prefixed `<providerId>/<id>` form — that is what
      // AiderDesk's `mainModel` field accepts. Bare-id inputs are REJECTED
      // because the wire ambiguity would silently route to the wrong
      // provider on the live host.
      if (!catalogModels.includes(override)) {
        throw new InvalidAiderDeskModelOverrideError(override, catalogModels);
      }
      resolvedMainModel = override;
    }

    // ── 7. BIND agentProfileId + (optional) mainModel + mode + workingMode
    const updateBody: AiderDeskTaskUpdate = {
      currentMode: assistantConfig.mode ?? 'agent',
      workingMode: 'local',
      activate: false,
    };
    if (resolvedAgentId) {
      updateBody.agentProfileId = resolvedAgentId;
    }
    if (resolvedMainModel !== undefined) {
      updateBody.mainModel = resolvedMainModel;
    }

    try {
      await client.updateTask(projectDir, taskId, updateBody);
      log.info(
        {
          taskId,
          agentProfileId: resolvedAgentId,
          mainModel: resolvedMainModel,
          profileName: resolvedProfile?.name ?? '(pin)',
        },
        'aiderdesk.task_bound'
      );
    } catch (error) {
      if (!resumeSucceeded) {
        // Fresh task failed to bind — the run would be incoherent otherwise.
        const aborted = abortSignal?.aborted ?? false;
        const errorClass = classifyAiderdeskError(error, aborted);
        log.error({ error: errorMessage(error), errorClass, taskId }, 'aiderdesk.task_bind_failed');
        yield {
          type: 'system',
          content: `⚠️ AiderDesk bind failed (${errorClass}): ${errorMessage(error)}`,
        };
        yield {
          type: 'result',
          isError: true,
          errors: [`Task bind failed: ${errorMessage(error)}`],
          sessionId: taskId,
          resumed: resumedOutcome(resumeSessionId, false),
        };
        return;
      }
      log.warn(
        { error: errorMessage(error), taskId },
        'aiderdesk.task_bind_failed_continue_with_resume'
      );
    }

    // ── 8. Optional: structured output augmentation ───────────────────────
    let effectivePrompt = prompt;
    if (requestOptions?.outputFormat?.schema) {
      effectivePrompt = augmentPromptForJsonSchema(prompt, requestOptions.outputFormat.schema);
    }

    // ── 9. Stream SSE frames from /api/run-prompt ────────────────────────
    const mode: 'code' | 'ask' | 'architect' | 'context' | 'agent' =
      assistantConfig.mode ?? 'agent';

    let finalMessage: string | null = null;
    let askedQuestion: string | null = null;
    let askedSystemEmitted = false;
    let errorSystemEmitted = false;
    let streamError: unknown;

    try {
      for await (const ev of client.runPromptStream({
        projectDir,
        taskId,
        prompt: effectivePrompt,
        mode,
        abortSignal,
        timeoutMs: requestTimeoutMs,
      })) {
        // Dispatch each SSE event kind onto the IAProvider chunk shape.
        switch (ev.kind) {
          case 'user-message':
            // Echoed input — ignore. The engine recorded the original `prompt:`
            // arg already; surfacing the echo would double-display it.
            break;

          case 'response-chunk':
            if (ev.chunk.length > 0) {
              yield { type: 'assistant', content: ev.chunk };
            }
            break;

          case 'response-completed':
            finalMessage = ev.content;
            break;

          case 'tool':
            if (ev.finished) {
              yield {
                type: 'tool_result',
                toolName: ev.toolName,
                toolOutput: ev.result ?? '',
                toolCallId: ev.messageId,
              };
            } else {
              yield { type: 'tool', toolName: ev.toolName, toolCallId: ev.messageId };
            }
            break;

          case 'ask-question':
            askedQuestion = ev.question;
            askedSystemEmitted = true;
            yield { type: 'system', content: `⚠️ ${ev.question}` };
            break;

          case 'log':
            if (ev.level === 'error') {
              errorSystemEmitted = true;
              yield {
                type: 'system',
                content: `⚠️ ${ev.message ?? 'aiderdesk log level=error'}`,
              };
            }
            break;

          case 'task-updated':
            lastSeenTaskState = ev.task.state;
            if (ev.task.state === 'INTERRUPTED') {
              throw new AiderDeskApiError(500, `AiderDesk task interrupted (${taskId})`, undefined);
            }
            break;

          case 'stream-end':
            break;

          case 'unknown':
            // Unrecognized event — diagnostic surface area only. Currently
            // left as a silent no-op so unrecognized event names do not
            // pollute the user-visible stream.
            break;
        }
      }
    } catch (error) {
      streamError = error;
    }

    // ── 10. Surface stream failure if any ─────────────────────────────────
    if (streamError) {
      const isInterrupt = errorMessage(streamError).toLowerCase().includes('interrupted');
      const aborted = abortSignal?.aborted ?? false;
      const errorClass = classifyAiderdeskError(streamError, aborted);
      log.error(
        { error: errorMessage(streamError), errorClass, taskId },
        'aiderdesk.run_prompt_stream_failed'
      );
      if (!errorSystemEmitted && !isInterrupt) {
        yield {
          type: 'system',
          content: `⚠️ AiderDesk stream failed (${errorClass}): ${errorMessage(streamError)}`,
        };
      }
      yield {
        type: 'result',
        isError: true,
        errors: [errorMessage(streamError)],
        sessionId: taskId,
        stopReason: isInterrupt ? 'interrupted' : undefined,
        resumed: resumedOutcome(resumeSessionId, resumeSucceeded),
      };
      return;
    }

    // ── 11. Parse structured output if declared ──────────────────────────
    let structuredOutput: unknown;
    if (requestOptions?.outputFormat?.schema && finalMessage) {
      structuredOutput = tryParseStructuredOutput(finalMessage);
    }

    // ── 12. Yield result chunk ───────────────────────────────────────────
    const isError =
      lastSeenTaskState === 'INTERRUPTED' || (askedQuestion != null && !askedSystemEmitted);
    const stopReason = askedQuestion
      ? 'awaiting_user_input'
      : lastSeenTaskState === 'INTERRUPTED'
        ? 'interrupted'
        : 'end_turn';

    const resultChunk: MessageChunk = {
      type: 'result',
      sessionId: taskId,
      structuredOutput,
      isError,
      stopReason,
      // Prefer the override as the user-visible model label; fall back to
      // the catalog profile name when no override was supplied.
      resolvedModel: {
        id: resolvedMainModel ?? resolvedProfile?.name ?? '(unbound)',
      },
    };

    // Wrap with withResumedOutcome so the resumed flag is correct on the
    // terminal chunk.
    yield* withResumedOutcome(
      (async function* (): AsyncGenerator<MessageChunk> {
        yield resultChunk;
      })(),
      resumedOutcome(resumeSessionId, resumeSucceeded)
    );
  }

  getType(): string {
    return 'aiderdesk';
  }

  getCapabilities(): ProviderCapabilities {
    return AIDERDESK_CAPABILITIES;
  }

  /**
   * Internal: lazy-fetch the AiderDesk agent-profile catalog with the
   * 60s-TTL cache. On network failure the catalog would be empty — caller
   * surfaces that as an UnknownAiderDeskAgentProfileError.
   */
  private async getCachedAgents(client: AiderDeskClient): Promise<AiderDeskProfile[]> {
    const now = Date.now();
    if (
      this.agentProfilesCache &&
      now - this.agentProfilesCache.fetchedAt <= CATALOG_TTL_MS
    ) {
      return this.agentProfilesCache.agents;
    }
    const agents = await client.listAgentProfiles();
    this.agentProfilesCache = { agents, fetchedAt: now };
    return agents;
  }

  /**
   * Internal: lazy-fetch the AiderDesk model catalog (joined to prefixed
   * `<providerId>/<id>` form) with the 60s-TTL cache.
   */
  private async getCachedModels(client: AiderDeskClient): Promise<string[]> {
    const now = Date.now();
    if (
      this.modelsCache &&
      now - this.modelsCache.fetchedAt <= CATALOG_TTL_MS
    ) {
      return this.modelsCache.models;
    }
    const models = await client.getModels();
    const joined = models.map(joinModelRef);
    this.modelsCache = { models: joined, fetchedAt: now };
    return joined;
  }
}
