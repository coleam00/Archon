import { spawn } from 'node:child_process';

import { createLogger } from '@archon/paths';

import type { MessageChunk, SendQueryOptions } from '../../types';

export type PromptMode = 'arg' | 'stdin';

export interface LocalCliCommand {
  command: string;
  args: string[];
  promptMode: PromptMode;
}

export interface LocalCliRunOptions {
  providerId: string;
  prompt: string;
  cwd: string;
  command: LocalCliCommand;
  requestOptions?: SendQueryOptions;
}

type ProcessEvent =
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'close'; code: number | null; signal: NodeJS.Signals | null }
  | { type: 'error'; error: Error };

const DEFAULT_TERMINATION_GRACE_MS = 5_000;
const PROCESS_GROUP_POLL_MS = 50;

/** Lazy-initialized loggers, keyed by provider id for readable log modules. */
const loggers = new Map<string, ReturnType<typeof createLogger>>();

function getLog(providerId: string): ReturnType<typeof createLogger> {
  const existing = loggers.get(providerId);
  if (existing) return existing;
  const log = createLogger(`provider.${providerId}`);
  loggers.set(providerId, log);
  return log;
}

function buildProcessEnv(requestEnv?: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, ...(requestEnv ?? {}) };
}

function getStructuredSchema(
  requestOptions?: SendQueryOptions
): Record<string, unknown> | undefined {
  return requestOptions?.outputFormat?.schema ?? requestOptions?.nodeConfig?.output_format;
}

export function augmentPromptForCliJsonSchema(
  prompt: string,
  schema: Record<string, unknown>
): string {
  return `${prompt}

---

CRITICAL: Respond with ONLY a JSON object matching the schema below. No prose before or after the JSON. No markdown code fences. Just the raw JSON object as your final message.

Schema:
${JSON.stringify(schema, null, 2)}`;
}

function extractJsonCandidate(output: string): string | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;

  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed);
  if (fenced?.[1]) {
    const candidate = fenced[1].trim();
    if (candidate.startsWith('{') && candidate.endsWith('}')) return candidate;
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return undefined;
}

function parseStructuredOutput(output: string): Record<string, unknown> | undefined {
  const candidate = extractJsonCandidate(output);
  if (!candidate) return undefined;
  try {
    const parsed = JSON.parse(candidate) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function* processEvents(child: ReturnType<typeof spawn>): AsyncGenerator<ProcessEvent> {
  const queue: ProcessEvent[] = [];
  let wake: (() => void) | undefined;
  let done = false;

  const push = (event: ProcessEvent): void => {
    queue.push(event);
    wake?.();
    wake = undefined;
  };

  child.stdout?.on('data', chunk => {
    push({ type: 'stdout', data: String(chunk) });
  });
  child.stderr?.on('data', chunk => {
    push({ type: 'stderr', data: String(chunk) });
  });
  child.on('error', error => {
    push({ type: 'error', error });
  });
  child.on('close', (code, signal) => {
    done = true;
    push({ type: 'close', code, signal });
  });

  while (!done || queue.length > 0) {
    if (queue.length === 0) {
      await new Promise<void>(resolve => {
        wake = resolve;
      });
      continue;
    }
    const next = queue.shift();
    if (next) yield next;
  }
}

function getTerminationGraceMs(): number {
  const override = process.env.ARCHON_LOCAL_CLI_TERMINATION_GRACE_MS;
  if (!override) return DEFAULT_TERMINATION_GRACE_MS;

  const parsed = Number(override);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TERMINATION_GRACE_MS;
}

function sendSignal(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (!child.pid) return;

  try {
    if (process.platform === 'win32') {
      child.kill(signal);
      return;
    }

    process.kill(-child.pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return;

    try {
      child.kill(signal);
    } catch (fallbackError) {
      if ((fallbackError as NodeJS.ErrnoException).code !== 'ESRCH') throw fallbackError;
    }
  }
}

function isProcessGroupAlive(pid: number): boolean {
  if (process.platform === 'win32') return false;

  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForProcessGroupExit(
  child: ReturnType<typeof spawn>,
  graceMs: number
): Promise<void> {
  if (process.platform === 'win32' || !child.pid) return;

  const pid = child.pid;
  const waitUntil = async (deadline: number): Promise<boolean> => {
    while (Date.now() < deadline) {
      if (!isProcessGroupAlive(pid)) return true;
      await new Promise(resolve => setTimeout(resolve, PROCESS_GROUP_POLL_MS));
    }
    return !isProcessGroupAlive(pid);
  };

  if (await waitUntil(Date.now() + graceMs)) return;

  sendSignal(child, 'SIGKILL');
  await waitUntil(Date.now() + 1_000);
}

export async function* runLocalCliProvider(
  options: LocalCliRunOptions
): AsyncGenerator<MessageChunk> {
  const { providerId, cwd, requestOptions, command } = options;
  const schema = getStructuredSchema(requestOptions);
  const prompt = schema ? augmentPromptForCliJsonSchema(options.prompt, schema) : options.prompt;
  const args = command.promptMode === 'arg' ? [...command.args, prompt] : command.args;
  const env = buildProcessEnv(requestOptions?.env);
  const log = getLog(providerId);

  log.info(
    {
      cwd,
      command: command.command,
      args: args.map(arg => (arg === prompt ? '<prompt>' : arg)),
      promptMode: command.promptMode,
      structuredOutput: Boolean(schema),
    },
    'local_cli.start'
  );

  const child = spawn(command.command, args, {
    cwd,
    detached: process.platform !== 'win32',
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const terminationGraceMs = getTerminationGraceMs();
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let aborted = Boolean(requestOptions?.abortSignal?.aborted);
  const clearKillTimer = (): void => {
    if (!killTimer) return;
    clearTimeout(killTimer);
    killTimer = undefined;
  };

  const abortHandler = (): void => {
    aborted = true;
    sendSignal(child, 'SIGTERM');
    if (killTimer) return;
    killTimer = setTimeout(() => {
      sendSignal(child, 'SIGKILL');
    }, terminationGraceMs);
    killTimer.unref?.();
  };
  if (requestOptions?.abortSignal?.aborted) {
    abortHandler();
  } else {
    requestOptions?.abortSignal?.addEventListener('abort', abortHandler, { once: true });
  }

  if (command.promptMode === 'stdin') {
    child.stdin?.write(prompt);
  }
  child.stdin?.end();

  let stdout = '';
  let stderr = '';

  try {
    for await (const event of processEvents(child)) {
      if (event.type === 'close') {
        requestOptions?.abortSignal?.removeEventListener('abort', abortHandler);
        if (aborted) {
          await waitForProcessGroupExit(child, terminationGraceMs);
          clearKillTimer();
          throw new Error(`${providerId} query aborted`);
        }
        clearKillTimer();
        if (event.code !== 0) {
          const error = stderr.trim() || `${providerId} exited with code ${String(event.code)}`;
          log.error({ code: event.code, signal: event.signal, stderr }, 'local_cli.failed');
          yield {
            type: 'result',
            isError: true,
            errorSubtype: `${providerId}_process_failed`,
            errors: [error],
          };
          return;
        }

        const structuredOutput = schema ? parseStructuredOutput(stdout) : undefined;
        if (schema && structuredOutput === undefined) {
          yield {
            type: 'system',
            content: `${providerId} did not return parseable JSON for the requested output_format.`,
          };
        }

        yield {
          type: 'result',
          ...(structuredOutput !== undefined ? { structuredOutput } : {}),
        };
        return;
      }

      if (aborted) continue;

      if (event.type === 'stdout') {
        stdout += event.data;
        yield { type: 'assistant', content: event.data };
      } else if (event.type === 'stderr') {
        stderr += event.data;
      } else if (event.type === 'error') {
        log.error({ err: event.error }, 'local_cli.spawn_error');
        yield {
          type: 'result',
          isError: true,
          errorSubtype: `${providerId}_spawn_error`,
          errors: [event.error.message],
        };
        return;
      }
    }
  } finally {
    requestOptions?.abortSignal?.removeEventListener('abort', abortHandler);
    clearKillTimer();
  }
}
