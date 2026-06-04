/**
 * Classify provider errors for retry policy.
 */
export type ErrorType = 'TRANSIENT' | 'FATAL' | 'UNKNOWN';

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
];

export function matchesPattern(message: string, patterns: string[]): boolean {
  return patterns.some(pattern => message.includes(pattern));
}

export function classifyError(error: Error): ErrorType {
  const message = error.message.toLowerCase();
  if (matchesPattern(message, FATAL_PATTERNS)) return 'FATAL';
  if (matchesPattern(message, TRANSIENT_PATTERNS)) return 'TRANSIENT';
  return 'UNKNOWN';
}
