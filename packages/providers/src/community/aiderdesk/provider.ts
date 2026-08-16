/**
 * AiderDesk provider — implements IAgentProvider by wrapping AiderDesk's REST API.
 *
 * Architecture:
 * - AiderDesk runs on the host at localhost:24337 (or via Docker bridge gateway
 *   at 172.18.0.1:24337 when Archon runs in a container).
 * - The provider creates/resumes AiderDesk tasks, binds a model with
 *   `POST /api/project/tasks {updates:{mainModel, currentMode, workingMode}}`,
 *   then opens a streaming `POST /api/run-prompt` with `Accept: text/event-stream`
 *   and forwards parsed SSE frames as MessageChunks.
 * - No SDK subprocess — pure HTTP via the injectable AiderDeskClient.
 * - Session resume: AiderDesk tasks persist their conversation; resume by
 *   loading the task ID.
 *
 * sendQuery() flow (bind-then-stream, issue: empty handshake on unbound task):
 *   1. Parse config (defensive, never throws).
 *   2. Resolve API URL (env → Docker detection → localhost).
 *   3. Create or resume an AiderDesk task.
 *   4. BIND mainModel/currentMode/workingMode via /api/project/tasks (this is
 *      the load-bearing step — without it, AiderDesk's project-default agent
 *      hijacks routing and run-prompt returns the empty 14-s handshake).
 *   5. Apply output_format prompt augmentation (best-effort JSON Schema path).
 *   6. Stream SSE frames from /api/run-prompt and dispatch each `kind` onto
 *      the IAProvider chunk shape.
 *   7. Yield final result chunk with sessionId, stopReason, resolved model.
 *   8. Stamp `resumed` via withResumedOutcome for resume reporting.
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
import { classifyAiderdeskError, errorMessage } from './errors';
import { AiderDeskApiError } from './errors';
import type { AiderDeskTaskState } from './types';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.aiderdesk');
  return cachedLog;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 300_000; // 5 minutes — caps a single stream

/**
 * Parse a model ref in 'provider/model' format.
 * Returns null if the format is invalid.
 */
function parseModelRef(modelRef: string): { providerId: string; modelId: string } | null {
  const slashIndex = modelRef.indexOf('/');
  if (slashIndex <= 0 || slashIndex === modelRef.length - 1) return null;

  const providerId = modelRef.slice(0, slashIndex).trim();
  const modelId = modelRef.slice(slashIndex + 1).trim();
  if (!providerId || !modelId) return null;

  return { providerId, modelId };
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
      apiKey: requestOptions?.env?.AIDERDESK_API_KEY ?? process.env.AIDERDESK_API_KEY,
      timeoutMs: requestTimeoutMs,
    });

    // ── 4. Resolve model ─────────────────────────────────────────────────
    const modelRef = requestOptions?.model ?? assistantConfig.model;
    if (!modelRef) {
      yield {
        type: 'system',
        content: '⚠️ No model specified for AiderDesk provider. Set model in config or node.',
      };
      yield {
        type: 'result',
        isError: true,
        errors: ['No model specified. Set assistants.aiderdesk.model or node-level model.'],
      };
      return;
    }

    const parsedModel = parseModelRef(modelRef);
    if (!parsedModel) {
      yield {
        type: 'system',
        content: `⚠️ Invalid model format '${modelRef}'. Expected 'provider/model' (e.g. 'poe/minimax-m3').`,
      };
      yield {
        type: 'result',
        isError: true,
        errors: [`Invalid model format: ${modelRef}`],
      };
      return;
    }

    // ── 5. Resolve task (create or resume) ────────────────────────────────
    let taskId: string;
    let resumeSucceeded = false;
    let lastSeenTaskState: AiderDeskTaskState | undefined;

    try {
      if (resumeSessionId) {
        try {
          const task = await client.loadTask(cwd, resumeSessionId);
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
          const newTask = await client.createTask(cwd);
          taskId = newTask.id;
          lastSeenTaskState = newTask.state;
        }
      } else {
        const newTask = await client.createTask(cwd);
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

    // ── 6. BIND mainModel + mode BEFORE run-prompt ───────────────────────
    // The load-bearing step. Without this, AiderDesk resolves the request to
    // its project-default agent (on the live host this is Claude with no API
    // key) and run-prompt returns the near-empty 14-s handshake. We tolerate
    // bind failure if the task was RESUMED — the resumed task may already
    // have the model bound by a prior run. Fresh tasks always bind.
    try {
      await client.updateTask(cwd, taskId, {
        mainModel: modelRef,
        currentMode: assistantConfig.mode ?? 'agent',
        workingMode: 'local',
        activate: false,
      });
      log.info({ taskId, model: modelRef }, 'aiderdesk.task_bound');
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

    // ── 7. Optional: structured output augmentation ───────────────────────
    let effectivePrompt = prompt;
    if (requestOptions?.outputFormat?.schema) {
      effectivePrompt = augmentPromptForJsonSchema(prompt, requestOptions.outputFormat.schema);
    }

    // ── 8. Stream SSE frames from /api/run-prompt ────────────────────────
    const mode: 'code' | 'ask' | 'architect' | 'context' | 'agent' =
      assistantConfig.mode ?? 'agent';

    let finalMessage: string | null = null;
    let askedQuestion: string | null = null;
    let askedSystemEmitted = false;
    let errorSystemEmitted = false;
    let streamError: unknown;

    try {
      for await (const ev of client.runPromptStream({
        projectDir: cwd,
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

    // ── 9. Surface stream failure if any ─────────────────────────────────
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

    // ── 10. Parse structured output if declared ──────────────────────────
    let structuredOutput: unknown;
    if (requestOptions?.outputFormat?.schema && finalMessage) {
      structuredOutput = tryParseStructuredOutput(finalMessage);
    }

    // ── 11. Yield result chunk ───────────────────────────────────────────
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
      resolvedModel: { id: modelRef },
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
}
