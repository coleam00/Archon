import { describe, expect, it } from 'bun:test';
import {
  deriveRunToken,
  verifyRunToken,
  deriveSessionToken,
  verifySessionToken,
  RUN_TOKEN_PREFIX,
  SESSION_TOKEN_PREFIX,
} from './run-token';

describe('run-token', () => {
  it('derives a deterministic run token with art_ prefix', () => {
    const token1 = deriveRunToken('run-123');
    const token2 = deriveRunToken('run-123');
    expect(token1).toBe(token2);
    expect(token1.startsWith(RUN_TOKEN_PREFIX)).toBe(true);
  });

  it('produces different tokens for different run IDs', () => {
    const token1 = deriveRunToken('run-123');
    const token2 = deriveRunToken('run-456');
    expect(token1).not.toBe(token2);
  });

  it('verifies valid run tokens correctly', () => {
    const token = deriveRunToken('run-123');
    expect(verifyRunToken('run-123', token)).toBe(true);
    expect(verifyRunToken('run-456', token)).toBe(false);
    expect(verifyRunToken('run-123', 'invalid-token')).toBe(false);
  });

  it('derives a deterministic session token with ast_ prefix', () => {
    const token1 = deriveSessionToken('conv-123');
    const token2 = deriveSessionToken('conv-123');
    expect(token1).toBe(token2);
    expect(token1.startsWith(SESSION_TOKEN_PREFIX)).toBe(true);
  });

  it('verifies valid session tokens correctly', () => {
    const token = deriveSessionToken('conv-123');
    expect(verifySessionToken('conv-123', token)).toBe(true);
    expect(verifySessionToken('conv-456', token)).toBe(false);
    expect(verifySessionToken('conv-123', 'invalid-token')).toBe(false);
  });
});
