import { describe, it, expect } from 'bun:test';
import { ValidationEngine } from '../../validation/engine';
import type { DagNode } from '../../schemas';

const node = (id: string, over: Partial<Record<string, unknown>> = {}): DagNode =>
  ({ id, prompt: 'x', ...over }) as unknown as DagNode;

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

describe('ValidationEngine.revalidate()', () => {
  it('is a no-op when no input has been provided', () => {
    const e = new ValidationEngine({ debounceMs: 20 });
    expect(() => e.revalidate()).not.toThrow();
    expect(e.snapshot().issues).toEqual([]);
  });

  it('re-runs tiers and advances lastRunAt when input is set', async () => {
    const e = new ValidationEngine({ debounceMs: 20 });
    e.update({ nodes: [node('a')] });
    // Wait for the first debounced run to settle.
    await sleep(50);
    const firstRunAt = e.snapshot().lastRunAt;
    expect(firstRunAt).toBeGreaterThan(0);

    // Bump clock so the next Date.now() is guaranteed to differ.
    await sleep(5);
    e.revalidate();
    await sleep(50);
    expect(e.snapshot().lastRunAt).toBeGreaterThan(firstRunAt);
  });
});
