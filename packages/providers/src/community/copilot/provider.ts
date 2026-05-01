/**
 * GitHub Copilot CLI community provider — main provider implementation.
 *
 * Spawns `copilot -p <prompt>` as a subprocess, streams stdout as assistant
 * chunks and stderr as system chunks, and yields a result chunk on exit.
 *
 * Security requirements:
 * - Uses spawn(binary, args, ...) — NEVER shell string concatenation.
 * - Inherits process.env and merges requestOptions.env (request env wins).
 * - Emits warning system chunk when broad permission flags are enabled.
 * - Conservative defaults: noAskUser defaults to true.
 * - Does not default allowAll, allowAllTools, or allowAllPaths to true.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { createLogger } from '@archon/paths';
import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
} from '../../types';
import { COPILOT_CAPABILITIES } from './capabilities';
import { parseCopilotConfig } from './config';
import { buildCopilotArgs } from './args';
import { resolveCopilotBinaryPath } from './binary-resolver';

/** Lazy-initialized logger */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.copilot');
  return cachedLog;
}

/** Default timeouts */
const DEFAULT_FIRST_EVENT_TIMEOUT_MS = 60_000; // 60s to see any output
const DEFAULT_PROCESS_TIMEOUT_MS = 10 * 60_000; // 10min total

/**
 * Merge process env with request-scoped env overrides.
 * Request env intentionally overrides inherited process env for project-scoped execution.
 */
function buildCopilotEnv(requestEnv?: Record<string, string>): Record<string, string> {
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  return { ...baseEnv, ...(requestEnv ?? {}) };
}

interface SpawnCommand {
  command: string;
  args: string[];
}

function resolvePathCommand(command: string): string {
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return command;
  }

  for (const pathDir of (process.env.PATH ?? '').split(delimiter)) {
    if (!pathDir) continue;
    const candidate = join(pathDir, command);
    if (existsSync(candidate)) return candidate;
  }

  return command;
}

function buildSpawnCommand(binary: string, argv: string[]): SpawnCommand {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(binary)) {
    return { command: binary, args: argv };
  }

  const resolvedBinary = resolvePathCommand(binary);
  const npmLoaderPath = join(
    dirname(resolvedBinary),
    'node_modules',
    '@github',
    'copilot',
    'npm-loader.js'
  );
  if (existsSync(npmLoaderPath)) {
    return { command: 'node', args: [npmLoaderPath, ...argv] };
  }

  return {
    command: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', resolvedBinary, ...argv],
  };
}

// ─── Unified event queue ────────────────────────────────────────────────────

type ProcessEvent =
  | { kind: 'stdout'; line: string }
  | { kind: 'stderr'; line: string }
  | { kind: 'exit'; code: number | null; signal: string | null }
  | { kind: 'error'; err: Error }
  | { kind: 'timeout'; reason: 'first_event' | 'process' }
  | { kind: 'abort' };

/**
 * Creates a simple async queue that multiple producers can push to and a
 * single consumer can drain via `next()`.
 */
function makeEventQueue(): {
  push: (item: ProcessEvent) => void;
  next: () => Promise<ProcessEvent>;
} {
  const buffer: ProcessEvent[] = [];
  const waiters: ((item: ProcessEvent) => void)[] = [];

  const push = (item: ProcessEvent): void => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter(item);
      return;
    }
    buffer.push(item);
  };

  const next = (): Promise<ProcessEvent> => {
    const item = buffer.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise<ProcessEvent>(resolve => {
      waiters.push(resolve);
    });
  };

  return { push, next };
}

/**
 * Attach data/end event listeners to a readable stream (or EventEmitter
 * shim in tests), splitting output into newline-terminated lines and
 * pushing each to the queue via `push`.
 *
 * Using event listeners instead of `for await` keeps this compatible with
 * both Node.js Readable streams (production) and plain EventEmitter shims
 * (unit tests).
 */
function pipeLinesToQueue(
  readable: NodeJS.ReadableStream,
  kind: 'stdout' | 'stderr',
  push: (item: ProcessEvent) => void,
  onData?: () => void
): void {
  let buf = '';

  readable.on('data', (chunk: Buffer | string) => {
    onData?.();
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      push({ kind, line: buf.slice(0, nl) });
      buf = buf.slice(nl + 1);
    }
  });

  readable.on('end', () => {
    if (buf.length > 0) {
      push({ kind, line: buf });
      buf = '';
    }
  });

  readable.on('error', (err: Error) => {
    push({ kind: 'error', err });
  });
}

/**
 * GitHub Copilot CLI provider.
 *
 * Implements IAgentProvider by spawning `copilot -p <prompt>` and streaming
 * its output as Archon MessageChunks.
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
    _resumeSessionId?: string,
    options?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const config = parseCopilotConfig(options?.assistantConfig ?? {});

    const argv = buildCopilotArgs({
      prompt,
      modelOverride: options?.model,
      config,
      nodeConfig: options?.nodeConfig,
    });

    // Security warnings for broad permission flags — inspect final argv so
    // extraArgs cannot silently bypass the provider's safety notice.
    if (argv.includes('--allow-all') || argv.includes('--yolo')) {
      yield {
        type: 'system',
        content:
          '⚠️  copilot: allowAll (--allow-all) is enabled — the agent has unrestricted access. ' +
          'Set allowAll: false in your config to restore conservative defaults.',
      };
    }
    if (argv.includes('--allow-all-tools')) {
      yield {
        type: 'system',
        content:
          '⚠️  copilot: allowAllTools (--allow-all-tools) is enabled — all tools are permitted. ' +
          'Set allowAllTools: false in your config to restore conservative defaults.',
      };
    }
    if (argv.includes('--allow-all-paths')) {
      yield {
        type: 'system',
        content:
          '⚠️  copilot: allowAllPaths (--allow-all-paths) is enabled — all filesystem paths are permitted. ' +
          'Set allowAllPaths: false in your config to restore conservative defaults.',
      };
    }
    if (argv.includes('--allow-all-urls')) {
      yield {
        type: 'system',
        content:
          '⚠️  copilot: allowAllUrls (--allow-all-urls) is enabled — all URLs are permitted. ' +
          'Set allowAllUrls: false in your config to restore conservative defaults.',
      };
    }

    const env = buildCopilotEnv(options?.env);
    let spawnCommand: SpawnCommand;
    let child: ReturnType<typeof spawn>;
    try {
      const binary = resolveCopilotBinaryPath(config.copilotBinaryPath);
      spawnCommand = buildSpawnCommand(binary, argv);

      // Log args with prompt redacted for safety
      getLog().info(
        { binary: spawnCommand.command, argc: spawnCommand.args.length },
        'copilot.spawn'
      );

      // ── Spawn ──────────────────────────────────────────────────────────────
      child = spawn(spawnCommand.command, spawnCommand.args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to start the Copilot CLI process.';
      yield {
        type: 'result',
        isError: true,
        errorSubtype: 'copilot_cli_exit',
        errors: [message],
      };
      return;
    }

    const firstEventTimeoutMs = config.firstEventTimeoutMs ?? DEFAULT_FIRST_EVENT_TIMEOUT_MS;
    const processTimeoutMs = config.processTimeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS;
    const abortSignal = options?.abortSignal;

    const { push, next } = makeEventQueue();
    let processExited = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const clearKillTimer = (): void => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
    };

    // Helper: kill the child process with a SIGTERM → SIGKILL escalation
    const killProcess = (reason: string): void => {
      if (!processExited) {
        clearKillTimer();
        getLog().info({ reason }, 'copilot.kill');
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          if (!processExited) child.kill('SIGKILL');
        }, 2000);
        killTimer.unref?.();
      }
    };

    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdout || !stderr) {
      killProcess('missing_stdio_pipe');
      clearKillTimer();
      yield {
        type: 'result',
        isError: true,
        errorSubtype: 'copilot_cli_exit',
        errors: ['Copilot CLI did not expose stdout/stderr pipes.'],
      };
      return;
    }

    // Abort signal handler — pushes an explicit abort event so the consumer
    // sees it even if it's currently blocked in `next()`.
    const onAbort = (): void => {
      killProcess('abort_signal');
      push({ kind: 'abort' });
    };
    if (abortSignal) {
      if (abortSignal.aborted) {
        killProcess('abort_signal_already_set');
        push({ kind: 'abort' });
      } else {
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }
    }

    // ── Producers ─────────────────────────────────────────────────────────
    let firstOutputSeen = false;
    const markFirstOutput = (): void => {
      firstOutputSeen = true;
    };

    // stdout producer
    pipeLinesToQueue(stdout, 'stdout', push, markFirstOutput);

    // stderr producer
    const stderrLines: string[] = [];
    pipeLinesToQueue(
      stderr,
      'stderr',
      item => {
        if (item.kind === 'stderr') stderrLines.push(item.line);
        push(item);
      },
      markFirstOutput
    );

    // close producer — waits until stdio streams are closed, preserving final buffered output.
    child.once('close', (code, signal) => {
      processExited = true;
      clearKillTimer();
      push({ kind: 'exit', code, signal });
    });
    child.once('error', err => {
      push({ kind: 'error', err });
    });

    // ── Timeout producers ─────────────────────────────────────────────────
    const timers: ReturnType<typeof setTimeout>[] = [];

    const firstEventTimer = setTimeout(() => {
      if (!firstOutputSeen) {
        push({ kind: 'timeout', reason: 'first_event' });
      }
    }, firstEventTimeoutMs);
    timers.push(firstEventTimer);

    const processTimer = setTimeout(() => {
      push({ kind: 'timeout', reason: 'process' });
    }, processTimeoutMs);
    timers.push(processTimer);

    const clearTimers = (): void => {
      for (const t of timers) clearTimeout(t);
    };

    // ── Consumer loop ──────────────────────────────────────────────────────
    try {
      let done = false;

      while (!done) {
        const event = await next();

        switch (event.kind) {
          case 'stdout': {
            const line = event.line.trimEnd();
            if (line.length > 0) {
              yield { type: 'assistant', content: line };
            }
            break;
          }

          case 'stderr': {
            const line = event.line.trimEnd();
            if (line.length > 0) {
              yield { type: 'system', content: line };
            }
            break;
          }

          case 'error': {
            getLog().error({ err: event.err.message }, 'copilot.stream_error');
            yield {
              type: 'result',
              isError: true,
              errorSubtype: 'copilot_cli_exit',
              errors: [event.err.message],
            };
            done = true;
            break;
          }

          case 'exit': {
            const { code, signal } = event;
            getLog().info({ exitCode: code, signal }, 'copilot.exit');

            if (code === 0) {
              yield { type: 'result' };
            } else {
              const exitMsg =
                signal != null
                  ? `Copilot CLI was killed by signal ${signal}`
                  : `Copilot CLI exited with code ${code ?? 'unknown'}`;
              yield {
                type: 'result',
                isError: true,
                errorSubtype: 'copilot_cli_exit',
                errors: [exitMsg, ...stderrLines.filter(l => l.trim().length > 0)],
              };
            }
            done = true;
            break;
          }

          case 'timeout': {
            const { reason } = event;
            killProcess(`timeout_${reason}`);
            const errMsg =
              reason === 'first_event'
                ? `Copilot CLI did not produce any output within ${firstEventTimeoutMs}ms. ` +
                  'Check that the copilot binary is installed and authenticated.'
                : `Copilot CLI exceeded the process timeout of ${processTimeoutMs}ms and was killed.`;
            getLog().error({ reason, firstEventTimeoutMs, processTimeoutMs }, 'copilot.timeout');
            yield {
              type: 'result',
              isError: true,
              errorSubtype: 'copilot_cli_exit',
              errors: [errMsg],
            };
            done = true;
            break;
          }

          case 'abort': {
            getLog().info({}, 'copilot.aborted');
            yield {
              type: 'result',
              isError: true,
              errorSubtype: 'copilot_cli_exit',
              errors: ['Copilot CLI query was aborted.'],
            };
            done = true;
            break;
          }
        }
      }
    } finally {
      clearTimers();
      clearKillTimer();
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
      if (!child.killed) child.kill('SIGTERM');
    }
  }
}
