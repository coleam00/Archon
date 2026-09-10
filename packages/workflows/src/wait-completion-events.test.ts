import { describe, expect, it } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { waitCompletionEvents } from './store';

const satisfied = {
  stepName: 'await-ci',
  result: { status: 'satisfied', waited_ms: 4200 } as const,
};

describe('waitCompletionEvents', () => {
  it('derives both rows from one result', () => {
    const rows = waitCompletionEvents('run-1', satisfied);
    expect(rows.outcome).toEqual({
      workflow_run_id: 'run-1',
      event_type: 'wait_completed',
      step_name: 'await-ci',
      data: satisfied.result,
    });
    expect(rows.node).toEqual({
      workflow_run_id: 'run-1',
      event_type: 'node_completed',
      step_name: 'await-ci',
      data: {
        type: 'wait',
        duration_ms: 4200,
        node_output: JSON.stringify(satisfied.result),
        structured_output: satisfied.result,
      },
    });
  });

  it('an expired event wait records wait_expired and still completes the node', () => {
    const rows = waitCompletionEvents('run-2', {
      stepName: 'await-signal',
      result: { status: 'expired', waited_ms: 60000, event: 'ci.concluded' },
    });
    expect(rows.outcome.event_type).toBe('wait_expired');
    expect(rows.node.event_type).toBe('node_completed');
    expect(rows.node.data?.duration_ms).toBe(60000);
  });

  it('is the only place that spells the wait node row, in either package', async () => {
    // The same-tick path (executor) and the resumed path (core store) both write this
    // row. A second spelling anywhere is the hand-synced pair this owner removes. The
    // row is recognised by its first two keys together: `type: 'wait'` alone also names
    // the wait node kind elsewhere (the ignored-fields table in schemas/dag-node.ts).
    const here = join(import.meta.dir);
    const workflowSources = (await readdir(here, { recursive: true }))
      .map(String)
      .filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .map(name => join(here, name));
    const coreStore = join(here, '..', '..', 'core', 'src', 'db', 'workflows.ts');
    const waitRow = /type:\s*'wait',\s*duration_ms\s*:/;
    const spellings: string[] = [];
    for (const file of [...workflowSources, coreStore]) {
      const source = await readFile(file, 'utf8');
      if (waitRow.test(source)) spellings.push(file);
    }
    expect(spellings).toEqual([join(here, 'store.ts')]);
  });
});
