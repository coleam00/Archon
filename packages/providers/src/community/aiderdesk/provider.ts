/**
 * AiderDesk provider — implements IAgentProvider by wrapping AiderDesk's REST API.
 *
 * Architecture:
 * - AiderDesk runs on the host at localhost:24337 (or via Docker bridge gateway
 *   at 172.18.0.1:24337 when Archon runs in a container).
 * - The provider creates/resumes AiderDesk tasks, runs prompts (blocking POST),
 *   and streams MessageChunk events back to the Archon workflow engine.
 * - No SDK subprocess — pure HTTP via the injectable AiderDeskClient.
 * - Session resume: AiderDesk tasks persist their conversation; resume by
 *   loading the task ID.
 *
 * sendQuery() flow:
 *   1. Parse config (defensive, never throws)
 *   2. Resolve API URL (env → Docker detection → localhost)
 *   3. Create or resume an AiderDesk task
 *   4. Call run-prompt (blocking POST with timeout + abort support)
 *   5. Extract assistant messages from the task response
 *   6. Yield assistant content as MessageChunk {type:'assistant'}
 *   7. Yield final result chunk with sessionId, tokens, cost
 *   8. Wrap with withResumedOutcome for resume reporting
 */
import { createLogger } from '@archon/paths';
import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
  TokenUsage,
} from '../../types';
import { withResumedOutcome, resumedOutcome } from '../../shared/resumed';
import {
  augmentPromptForJsonSchema,
  tryParseStructuredOutput,
} from '../../shared/structured-output';
import { AIDERDESK_CAPABILITIES } from './capabilities';
import { parseAiderdeskConfig } from './config';
import { AiderDeskClient, resolveDefaultApiUrl, type FetchFn } from './client';
import { classifyAiderdeskError, enrichAiderdeskError, errorMessage } from './errors';
import { TERMINAL_TASK_STATES, type AiderDeskMessage, type AiderDeskTaskFull } from './types';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.aiderdesk');
  return cachedLog;
}

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000; // 5 minutes
const MAX_POLL_DURATION_MS = 600_000; // 10 minutes total polling cap

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
 * Extract token usage from the last assistant message's usageReport.
 */
function extractTokenUsage(messages: AiderDeskMessage[]): TokenUsage | undefined {
  // Find the last assistant message with a usageReport
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant' && msg.usageReport) {
      const report = msg.usageReport;
      return {
        input: report.inputTokens ?? 0,
        output: report.outputTokens ?? 0,
        total: report.totalTokens,
        cost: report.cost,
      };
    }
  }
  return undefined;
}

/**
 * Extract the total cost from a task (aiderTotalCost + agentTotalCost).
 */
function extractTaskCost(task: AiderDeskTaskFull): number | undefined {
  const total = (task.aiderTotalCost ?? 0) + (task.agentTotalCost ?? 0);
  return total > 0 ? total : undefined;
}

/**
 * Check if a task state is terminal (polling should stop).
 */
function isTerminalState(state: string): boolean {
  return TERMINAL_TASK_STATES.has(state as never);
}

/**
 * Sleep helper that respects an abort signal.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }
    const timeoutId = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeoutId);
        reject(new Error('Aborted'));
      },
      { once: true }
    );
  });
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

    const pollIntervalMs = assistantConfig.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
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
        content: `⚠️ Invalid model format '${modelRef}'. Expected 'provider/model' (e.g. 'ollama/qwen3-coder:30b').`,
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

    if (resumeSessionId) {
      try {
        const task = await client.loadTask(cwd, resumeSessionId);
        taskId = task.id;
        resumeSucceeded = true;
        log.info({ taskId, state: task.state }, 'aiderdesk.task_resumed');
      } catch (error) {
        log.warn({ error: (error as Error).message, resumeSessionId }, 'aiderdesk.resume_failed');
        yield {
          type: 'system',
          content: '⚠️ Could not resume AiderDesk session. Starting fresh conversation.',
        };
        const newTask = await client.createTask(cwd);
        taskId = newTask.id;
      }
    } else {
      const newTask = await client.createTask(cwd);
      taskId = newTask.id;
      log.info({ taskId }, 'aiderdesk.task_created');
    }

    // ── 6. Optional: structured output augmentation ───────────────────────
    let effectivePrompt = prompt;
    let structuredOutput: unknown;

    if (requestOptions?.outputFormat?.schema) {
      effectivePrompt = augmentPromptForJsonSchema(prompt, requestOptions.outputFormat.schema);
    }

    // ── 7. Run prompt (blocking POST) ────────────────────────────────────
    const mode = assistantConfig.mode ?? 'code';

    let taskResult: AiderDeskTaskFull;
    try {
      log.info({ taskId, mode, model: modelRef }, 'aiderdesk.run_prompt_started');

      // runPrompt is a blocking call — it returns when the AiderDesk agent
      // finishes processing the prompt.
      taskResult = await client.runPrompt(cwd, taskId, effectivePrompt, mode, {
        abortSignal,
        timeoutMs: requestTimeoutMs,
      });

      log.info({ taskId, state: taskResult.state }, 'aiderdesk.run_prompt_completed');
    } catch (error) {
      const aborted = abortSignal?.aborted ?? false;
      const errorClass = classifyAiderdeskError(error, aborted);
      const enriched = enrichAiderdeskError(error, errorClass);

      log.error(
        { error: (error as Error).message, errorClass, taskId },
        'aiderdesk.run_prompt_failed'
      );

      yield {
        type: 'system',
        content: `⚠️ AiderDesk query failed (${errorClass}): ${errorMessage(error)}`,
      };

      yield {
        type: 'result',
        isError: true,
        errors: [enriched.message],
        sessionId: taskId,
        resumed: resumedOutcome(resumeSessionId, resumeSucceeded),
      };
      return;
    }

    // ── 8. If task is not yet terminal, poll for completion ──────────────
    // runPrompt returns when the HTTP call completes, but the task may still
    // be in a non-terminal state if AiderDesk's internal processing is async.
    const pollStart = Date.now();

    while (!isTerminalState(taskResult.state)) {
      if (Date.now() - pollStart > MAX_POLL_DURATION_MS) {
        log.warn({ taskId, state: taskResult.state }, 'aiderdesk.poll_timeout');
        yield {
          type: 'system',
          content: `⚠️ AiderDesk task timed out after ${MAX_POLL_DURATION_MS / 1000}s in state: ${taskResult.state}`,
        };
        yield {
          type: 'result',
          isError: true,
          errors: [`Task timed out in state: ${taskResult.state}`],
          sessionId: taskId,
          resumed: resumedOutcome(resumeSessionId, resumeSucceeded),
        };
        return;
      }

      if (abortSignal?.aborted) {
        yield {
          type: 'result',
          isError: true,
          errors: ['AiderDesk query aborted'],
          sessionId: taskId,
          resumed: resumedOutcome(resumeSessionId, resumeSucceeded),
        };
        return;
      }

      try {
        await sleep(pollIntervalMs, abortSignal);
      } catch {
        // Aborted during sleep
        yield {
          type: 'result',
          isError: true,
          errors: ['AiderDesk query aborted'],
          sessionId: taskId,
          resumed: resumedOutcome(resumeSessionId, resumeSucceeded),
        };
        return;
      }

      try {
        taskResult = await client.loadTask(cwd, taskId);
        log.debug({ taskId, state: taskResult.state }, 'aiderdesk.poll');
      } catch (error) {
        log.error({ error: (error as Error).message, taskId }, 'aiderdesk.poll_failed');
        // Continue polling — transient network errors shouldn't kill the run
      }
    }

    // ── 9. Extract and yield assistant messages ──────────────────────────
    const messages = taskResult.messages ?? [];
    const assistantMessages = messages.filter(m => m.role === 'assistant');

    // Yield each assistant message as a content chunk
    for (const msg of assistantMessages) {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      yield {
        type: 'assistant',
        content,
      };
    }

    // ── 10. Parse structured output if declared ──────────────────────────
    if (requestOptions?.outputFormat?.schema && assistantMessages.length > 0) {
      const lastContent = assistantMessages[assistantMessages.length - 1].content;
      structuredOutput = tryParseStructuredOutput(lastContent);
    }

    // ── 11. Optional: clear context ──────────────────────────────────────
    if (assistantConfig.clearContextAfterRun) {
      try {
        await client.clearContext(cwd, taskId);
      } catch {
        // Non-fatal — context cleanup failure shouldn't fail the run
        log.warn({ taskId }, 'aiderdesk.clear_context_failed');
      }
    }

    // ── 12. Yield result chunk ───────────────────────────────────────────
    const tokens = extractTokenUsage(messages);
    const cost = extractTaskCost(taskResult);
    const isError = taskResult.state === 'INTERRUPTED';

    const resultChunk: MessageChunk = {
      type: 'result',
      sessionId: taskId,
      tokens,
      cost,
      isError,
      structuredOutput,
      resolvedModel: { id: modelRef },
      stopReason: taskResult.state,
    };

    // Wrap with withResumedOutcome to stamp the resumed flag
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
