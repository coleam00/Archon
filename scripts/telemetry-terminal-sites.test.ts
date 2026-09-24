import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Terminal run telemetry has one owner: the run store reports each committed terminal
 * transition (packages/core/src/db/workflow-terminal-telemetry.ts). The only other caller
 * is the executor's report for a run whose row could never be created. A capture added
 * at any other site would double-count, or fire before its terminal write.
 */
const ALLOWED = new Set([
  'packages/core/src/db/workflow-terminal-telemetry.ts',
  'packages/workflows/src/executor.ts',
]);

describe('terminal run telemetry call sites', () => {
  it('only the run store and the executor run_not_created report call captureWorkflowTerminal', async () => {
    const repoRoot = join(import.meta.dir, '..');
    const callers: string[] = [];
    for await (const path of new Bun.Glob('packages/*/src/**/*.{ts,tsx}').scan(repoRoot)) {
      if (/\.(test|spec)\.tsx?$/.test(path) || path.endsWith('/telemetry.ts')) continue;
      const source = await readFile(join(repoRoot, path), 'utf8');
      if (source.includes('captureWorkflowTerminal(')) callers.push(path);
    }
    expect(callers.sort()).toEqual([...ALLOWED].sort());
  });
});
