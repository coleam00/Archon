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
 *   fatal (60) - Process cannot continue
 *   error (50) - Failures needing immediate attention
 *   warn  (40) - Degraded behavior, fallbacks
 *   info  (30) - Key user-visible events (DEFAULT)
 *   debug (20) - Internal details, tool calls, state transitions
 *   trace (10) - Fine-grained diagnostic output
 *
 * Configuration:
 *   LOG_LEVEL env var or setLogLevel() at startup
 *   Pretty-printed when stdout is a TTY and NODE_ENV !== 'production'
 *   Newline-delimited JSON otherwise (piped, redirected, or production)
 */

import pino from 'pino';
import type { Logger } from 'pino';
import pretty from 'pino-pretty';

export type { Logger } from 'pino';

const VALID_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace']);

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

/**
 * Build the root Pino logger.
 *
 * Uses `pino-pretty` as a **destination stream** (not a worker-thread transport)
 * when stdout is a TTY and NODE_ENV !== 'production'. Running pino-pretty as a
 * destination stream keeps the formatter on the main thread, which avoids the
 * `require.resolve('pino-pretty')` lookup that crashes inside Bun's `/$bunfs/`
 * virtual filesystem in compiled binaries (see GitHub issue #960 / #979).
 *
 * The same code path runs in dev and compiled binaries — no environment
 * detection required.
 */
function buildLogger(): Logger {
  const level = getInitialLevel();
  const usePretty = process.stdout.isTTY && process.env.NODE_ENV !== 'production';

  if (usePretty) {
    try {
      const stream = pretty({
        colorize: true,
        levelFirst: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      });
      return pino({ level }, stream);
    } catch (err) {
      // pino-pretty failed to initialize (missing peer, broken TTY descriptor,
      // or incompatible runtime). Fall back to plain JSON so logging keeps
      // working instead of crashing the entire process at module import time.
      console.warn(
        `[logger] pino-pretty failed to initialize, falling back to JSON output: ${(err as Error).message}`
      );
    }
  }

  return pino({ level });
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
