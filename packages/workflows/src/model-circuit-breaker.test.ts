import { describe, expect, test } from 'bun:test';
import { RunModelCircuitBreaker, MODEL_CIRCUIT_BREAKER_THRESHOLD } from './model-circuit-breaker';

describe('RunModelCircuitBreaker', () => {
  test('opens after threshold failures', () => {
    const b = new RunModelCircuitBreaker();
    const provider = 'omp';
    const model = 'cursor/composer-2.5';
    expect(b.isOpen(provider, model)).toBe(false);
    for (let i = 0; i < MODEL_CIRCUIT_BREAKER_THRESHOLD; i++) {
      b.recordFailure(provider, model);
    }
    expect(b.isOpen(provider, model)).toBe(true);
  });
});
