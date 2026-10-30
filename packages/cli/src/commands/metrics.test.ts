import { expect, test } from 'bun:test';
import { providerRegistry } from '@archon/providers';
import { loadConfig } from '@archon/core/config/config-loader';
import { metricsReportSchema } from '@archon/workflows/schemas/metric';
import { metricsCommand, type MetricsCommandOptions } from './metrics';
import {
  createInMemoryWorkflowHostStore,
  createInMemoryWorkflowStore,
} from '../test-support/workflow-store';

const now = new Date('2026-10-30T12:00:00Z');

async function fixture(units: string[]) {
  const records = createInMemoryWorkflowHostStore();
  const store = createInMemoryWorkflowStore(records);
  for (const unit of units) {
    const run = await store.createWorkflowRun({ workflow_name: 'count-prs', user_message: '' });
    await store.persistWorkflowEvent({
      workflow_run_id: run.id,
      event_type: 'node_completed',
      step_name: 'count',
      data: {
        structured_output: {
          metrics: [
            {
              name: 'factory.prs_merged',
              kind: 'count',
              unit,
              value: 2,
              subject: null,
              at: '2026-10-29T00:00:00Z',
            },
          ],
        },
      },
    });
  }
  const host = {
    records,
    deps: {
      store,
      providers: providerRegistry,
      loadConfig,
      getAgentProvider: (): never => {
        throw new Error('No provider');
      },
    },
  };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const invoke = (options: MetricsCommandOptions, name?: string): Promise<number> =>
    metricsCommand(host, name, options, {
      now,
      stdout: async text => {
        stdout.push(String(text));
      },
      stderr: async text => {
        stderr.push(String(text));
      },
    });
  return { invoke, stdout, stderr };
}

test('--since 7d ends the window now and starts it seven days earlier', async () => {
  const { invoke, stdout } = await fixture(['prs']);
  expect(await invoke({ since: '7d', json: true })).toBe(0);
  const report = metricsReportSchema.parse(JSON.parse(stdout.join('')));
  expect(report.window).toEqual({
    since: '2026-10-23T12:00:00.000Z',
    until: '2026-10-30T12:00:00.000Z',
  });
  expect(report.metrics.map(m => [m.name, m.instruments[0]?.value])).toEqual([
    ['factory.prs_merged', 2],
  ]);
});

test('--json emits exactly one parseable document', async () => {
  const { invoke, stdout } = await fixture(['prs', 'prs']);
  expect(await invoke({ json: true }, 'factory.prs_merged')).toBe(0);
  expect(stdout).toHaveLength(1);
  expect(metricsReportSchema.parse(JSON.parse(stdout[0] ?? '')).metrics[0]?.instruments[0]?.n).toBe(
    2
  );
});

test('a refused record exits 4 with an error naming both definitions', async () => {
  const { invoke, stdout, stderr } = await fixture(['prs', 'pull_requests']);
  expect(await invoke({})).toBe(4);
  expect(stdout.join('')).toContain('factory.prs_merged  count/prs  value 2  n 1');
  expect(stderr).toHaveLength(1);
  expect(stderr[0]).toMatch(
    /^error: metric factory\.prs_merged is count\/prs; run \S+ node count offered count\/pull_requests\n$/
  );
});

test('a malformed window is a usage error', async () => {
  const { invoke, stderr } = await fixture([]);
  expect(await invoke({ since: 'last week' })).toBe(1);
  expect(stderr.join('')).toContain('since must be a duration');
});
