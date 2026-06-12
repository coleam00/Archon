/**
 * Classify provider errors for retry policy.
 *
 * Single source of truth for error classification across layers:
 * - Providers use it for SDK-level retry (e.g. OMP bridgeSessionWithRetry).
 * - @archon/workflows imports it via the `@archon/providers/types` contract
 *   subpath for node retry and circuit-breaker accounting.
 *
 * The pattern lists below are the merged superset of the previously
 * duplicated providers/workflows lists — keep them here, never fork them.
 */
export type ErrorType = 'TRANSIENT' | 'FATAL' | 'UNKNOWN';

/** Fatal error patterns — auth/credential/identity issues that won't resolve with retry. */
export const FATAL_PATTERNS = [
  'unauthorized',
  'forbidden',
  'invalid token',
  'authentication failed',
  'permission denied',
  '401',
  '403',
  'credit balance',
  'auth error',
  'model not found',
  'invalid model',
  'no credentials',
];

/** Transient error patterns — temporary issues that may resolve with retry. */
export const TRANSIENT_PATTERNS = [
  'timeout',
  'timed out',
  'econnrefused',
  'econnreset',
  'etimedout',
  'rate limit',
  'too many requests',
  '429',
  '500',
  '502',
  '503',
  '504',
  '529',
  'overloaded',
  'network error',
  'socket hang up',
  'exited with code',
  'service unavailable',
  'bad gateway',
  'gateway timeout',
  'extension error',
  'handler timed out',
  'claude code crash',
  'produced no assistant output',
  'stream closed without yielding',
];

/** Check if error message matches any pattern in the list. */
export function matchesPattern(message: string, patterns: string[]): boolean {
  return patterns.some(pattern => message.includes(pattern));
}

/**
 * Classify an error to determine if it's transient (can retry) or fatal (should fail).
 * FATAL patterns take priority over TRANSIENT patterns to prevent an error message
 * containing both (e.g. "unauthorized: process exited with code 1") from being retried.
 */
export function classifyError(error: Error): ErrorType {
  const message = error.message.toLowerCase();
  if (matchesPattern(message, FATAL_PATTERNS)) return 'FATAL';
  if (matchesPattern(message, TRANSIENT_PATTERNS)) return 'TRANSIENT';
  return 'UNKNOWN';
}
