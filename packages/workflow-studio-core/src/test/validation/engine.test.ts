import { describe, it, expect, beforeEach } from 'bun:test';
import { ValidationEngine } from '../../validation/engine';
import type { DagNode } from '../../schemas';
import type { WorkflowApiClient } from '../../api/WorkflowApiClient';

// ---------------------------------------------------------------------------
// Helpers — flat-shape DagNode casts through `unknown`.
// Real DagNode variants have no `type` discriminant or `base` wrapper (drift
// 6.1.1). Flat shape matches structural/graph/content spec helpers.
// ---------------------------------------------------------------------------

const node = (id: string, over: Partial<Record<string, unknown>> = {}): DagNode =>
  ({ id, prompt: 'x', ...over }) as unknown as DagNode;

const stubClient = (
  impl: (def: unknown) => Promise<{ valid: boolean; errors?: string[] }>
): WorkflowApiClient => ({ validateWorkflow: impl }) as unknown as WorkflowApiClient;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------

describe('ValidationEngine', () => {
  let engine: ValidationEngine;
  beforeEach(() => {
    engine = new ValidationEngine({ debounceMs: 50 });
  });

  it('runs instant tier synchronously', () => {
    engine.update({ nodes: [node('')] });
    expect(engine.snapshot().issues.some(i => i.rule === 'structural.id.empty')).toBe(true);
  });

  it('coalesces a burst of updates into one debounced run', async () => {
    let runs = 0;
    const e = new ValidationEngine({ debounceMs: 30, onDebouncedRun: () => runs++ });
    for (let i = 0; i < 10; i++) e.update({ nodes: [node('a', { depends_on: ['ghost'] })] });
    await sleep(80);
    expect(runs).toBe(1);
    expect(e.snapshot().issues.some(i => i.rule === 'graph.ref.unknown')).toBe(true);
  });

  it('clears debounced issues when the workflow becomes clean', async () => {
    const e = new ValidationEngine({ debounceMs: 30 });
    e.update({ nodes: [node('a', { depends_on: ['ghost'] })] });
    await sleep(60);
    expect(e.snapshot().issues.some(i => i.rule === 'graph.ref.unknown')).toBe(true);
    e.update({ nodes: [node('a')] });
    await sleep(60);
    expect(e.snapshot().issues.some(i => i.rule === 'graph.ref.unknown')).toBe(false);
  });

  it('does not call server validate while client errors exist', async () => {
    let calls = 0;
    const client = stubClient(async () => {
      calls++;
      return { valid: true };
    });
    const e = new ValidationEngine({ debounceMs: 20, client });
    e.update({ nodes: [node('')] });
    await sleep(80);
    expect(calls).toBe(0);
  });

  it('calls server validate after debounced settles with no client errors', async () => {
    let calls = 0;
    const client = stubClient(async () => {
      calls++;
      return { valid: false, errors: ['boom'] };
    });
    const e = new ValidationEngine({ debounceMs: 20, client });
    e.update({ nodes: [node('a')], definition: { name: 'w', nodes: [] } as never });
    await sleep(80);
    expect(calls).toBe(1);
    expect(e.snapshot().issues.some(i => i.rule.startsWith('server.'))).toBe(true);
  });

  it('drops stale server responses by sequence number', async () => {
    let idx = 0;
    const responses = [
      async () => {
        await sleep(60);
        return { valid: false, errors: ['stale'] };
      },
      async () => {
        await sleep(5);
        return { valid: false, errors: ['fresh'] };
      },
    ];
    const client = stubClient(() => responses[idx++]());
    const e = new ValidationEngine({ debounceMs: 10, client });
    e.update({ nodes: [node('a')], definition: { name: 'w' } as never });
    await sleep(25);
    e.update({ nodes: [node('a'), node('b')], definition: { name: 'w' } as never });
    await sleep(120);
    const msgs = e
      .snapshot()
      .issues.filter(i => i.source === 'server')
      .map(i => i.message);
    expect(msgs).toContain('fresh');
    expect(msgs).not.toContain('stale');
  });

  it('clears serverIssues when client errors appear mid-server-call', async () => {
    const client = stubClient(async () => {
      await sleep(60);
      return { valid: false, errors: ['stale server claim'] };
    });
    const e = new ValidationEngine({ debounceMs: 10, client });
    // Clean nodes → server tier fires after debounce
    e.update({ nodes: [node('a')], definition: { name: 'w' } as never });
    await sleep(25); // debounce fires (t=10), runServer in flight (~35ms remain)
    // Introduce a client error → triggers the else-branch race path
    e.update({ nodes: [node('')], definition: { name: 'w' } as never });
    // Second debounce fires (~t=35), aborts + bumps seq + clears serverIssues.
    // Stale promise resolves around t=70 with mySeq !== this.seq, must no-op.
    await sleep(80);
    const serverIssues = e.snapshot().issues.filter(i => i.source === 'server');
    expect(serverIssues).toEqual([]);
  });

  it('returns a stable snapshot reference between mutations', () => {
    const e = new ValidationEngine({ debounceMs: 50 });
    e.update({ nodes: [node('a')] });
    const a = e.snapshot();
    const b = e.snapshot();
    expect(a).toBe(b); // same reference until next state change
  });

  it('notifies subscribers on snapshot change', async () => {
    const seen: number[] = [];
    const e = new ValidationEngine({ debounceMs: 20 });
    const off = e.subscribe(() => seen.push(e.snapshot().issues.length));
    e.update({ nodes: [node('')] });
    await sleep(60);
    e.update({ nodes: [node('a')] });
    await sleep(60);
    off();
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });
});
