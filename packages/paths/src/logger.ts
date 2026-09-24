/**
 * Structured logging utility built on Pino
 *
 * Usage:
 *   import { createLogger } from '@archon/paths';
 *   const log = createLogger('orchestrator');
 *   log.info({ conversationId }, 'session_started');
 *   log.error({ err, conversationId }, 'session_failed');
 *
 * Log levels (standard Pino levels):
 *   fatal  (60) - Process cannot continue
 *   error  (50) - Failures needing immediate attention
 *   warn   (40) - Degraded behavior, fallbacks
 *   info   (30) - Key user-visible events (DEFAULT)
 *   debug  (20) - Internal details, tool calls, state transitions
 *   trace  (10) - Fine-grained diagnostic output
 *   silent      - Disables all logging (used by the CLI in --json mode so no
 *                 log line can interleave with the machine-readable payload)
 *
 * Configuration:
 *   LOG_LEVEL env var or setLogLevel() at startup
 *   stdout by default; setLogDestination('stderr') moves every logger there
 *   Pretty-printed when the destination is a TTY and NODE_ENV !== 'production'
 *   Newline-delimited JSON otherwise (piped, redirected, or production)
 */

import pino from 'pino';
import type { DestinationStream, Logger } from 'pino';
import pretty from 'pino-pretty';

export type { Logger } from 'pino';

// 'silent' is Pino's built-in level that disables all output. The CLI uses it
// in --json mode to keep stdout to exactly the JSON payload.
const VALID_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

function getInitialLevel(): string {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase();
  if (envLevel) {
    if (VALID_LEVELS.has(envLevel)) {
      return envLevel;
    }
    // Warn via console since the logger itself isn't configured yet
    console.warn(
      `[logger] Invalid LOG_LEVEL '${process.env.LOG_LEVEL}'. ` +
        `Valid levels: ${[...VALID_LEVELS].join(', ')}. Falling back to 'info'.`
    );
  }
  return 'info';
}

export type LogDestination = 'stdout' | 'stderr';

let destination: LogDestination = 'stdout';
const streams: Partial<Record<LogDestination, DestinationStream>> = {};

/**
 * Build the stream for one destination.
 *
 * Uses `pino-pretty` as a **destination stream** (not a worker-thread transport)
 * when that destination is a TTY and NODE_ENV !== 'production'. Running
 * pino-pretty as a destination stream keeps the formatter on the main thread,
 * which avoids the `require.resolve('pino-pretty')` lookup that crashes inside
 * Bun's `/$bunfs/` virtual filesystem in compiled binaries (see GitHub issue
 * #960 / #979).
 *
 * The same code path runs in dev and compiled binaries — no environment
 * detection required.
 */
function buildStream(target: LogDestination): DestinationStream {
  const fd = target === 'stdout' ? 1 : 2;
  const isTTY = target === 'stdout' ? process.stdout.isTTY : process.stderr.isTTY;

  if (isTTY && process.env.NODE_ENV !== 'production') {
    try {
      return pretty({
        colorize: true,
        levelFirst: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
        destination: fd,
      });
    } catch (err) {
      // pino-pretty failed to initialize (missing peer, broken TTY descriptor,
      // or incompatible runtime). Fall back to plain JSON so logging keeps
      // working instead of crashing the process on its first log line.
      console.warn(
        `[logger] pino-pretty failed to initialize, falling back to JSON output: ${(err as Error).message}`
      );
    }
  }

  // The process stream, not `pino.destination(fd)`: it is what pino picks by
  // default under Bun, and it keeps log lines in order with `console` output
  // written to the same stream.
  return target === 'stdout' ? process.stdout : process.stderr;
}

/**
 * Build the root Pino logger.
 *
 * Child loggers share the root's stream, and modules create them at import
 * time, before the CLI has parsed its arguments. So the destination is resolved
 * on each write rather than when the logger is built, and each destination's
 * stream is built on its first write.
 */
function buildLogger(): Logger {
  return pino(
    { level: getInitialLevel() },
    {
      write(line: string): void {
        const stream = (streams[destination] ??= buildStream(destination));
        stream.write(line);
      },
    }
  );
}

/**
 * Root Pino logger instance.
 * Children inherit the root's level at creation time (not dynamically updated).
 */
export const rootLogger: Logger = buildLogger();

/**
 * Create a child logger with a module binding.
 *
 * @param module - Dotted namespace for the module (e.g. 'orchestrator', 'workflow.executor')
 * @returns Pino child logger with `{ module }` binding
 */
export function createLogger(module: string): Logger {
  return rootLogger.child({ module });
}

/**
 * Set the log level on the root logger at runtime.
 * Only affects child loggers created after this call.
 * Call early in startup before modules call createLogger().
 *
 * @param level - One of: 'fatal', 'error', 'warn', 'info', 'debug', 'trace'
 * @throws Error if level is not a valid Pino log level
 */
export function setLogLevel(level: string): void {
  const normalized = level.toLowerCase();
  if (!VALID_LEVELS.has(normalized)) {
    throw new Error(`Invalid log level: '${level}'. Valid levels: ${[...VALID_LEVELS].join(', ')}`);
  }
  rootLogger.level = normalized;
}

export function getLogLevel(): string {
  return rootLogger.level;
}

/**
 * Choose where every logger writes from now on, including loggers already
 * created. The server keeps the default, stdout, which container runtimes
 * collect. The CLI moves logs to stderr so a command's stdout carries only
 * that command's output.
 */
export function setLogDestination(target: LogDestination): void {
  destination = target;
}
