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

/** One run per entry, each recording a `prs` count for no subject, overridden by the entry. */
async function fixture(overrides: Record<string, unknown>[]) {
  const records = createInMemoryWorkflowHostStore();
  const store = createInMemoryWorkflowStore(records);
  for (const override of overrides) {
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
              unit: 'prs',
              value: 2,
              subject: null,
              at: '2026-10-29T00:00:00Z',
              ...override,
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
  const { invoke, stdout } = await fixture([{}]);
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
  const { invoke, stdout } = await fixture([{}, {}]);
  expect(await invoke({ json: true }, 'factory.prs_merged')).toBe(0);
  expect(stdout).toHaveLength(1);
  expect(metricsReportSchema.parse(JSON.parse(stdout[0] ?? '')).metrics[0]?.instruments[0]?.n).toBe(
    2
  );
});

test('a refused record exits 4 with an error naming both definitions', async () => {
  const { invoke, stdout, stderr } = await fixture([{}, { unit: 'pull_requests' }]);
  expect(await invoke({})).toBe(4);
  expect(stdout.join('')).toContain('factory.prs_merged  count/prs  value 2  n 1');
  expect(stderr).toHaveLength(1);
  expect(stderr[0]).toMatch(
    /^error: metric factory\.prs_merged is count\/prs; run \S+ node count offered count\/pull_requests\n$/
  );
});

test('a refusal names the metric a score calibrates', async () => {
  const score = { kind: 'score', unit: 'agreement', value: 0.8 };
  const { invoke, stderr } = await fixture([
    { ...score, calibrates: 'factory.review_quality' },
    score,
  ]);
  expect(await invoke({})).toBe(4);
  expect(stderr[0]).toMatch(
    /^error: metric factory\.prs_merged is score\/agreement calibrates factory\.review_quality; run \S+ node count offered score\/agreement\n$/
  );
});

test('a malformed window is a usage error', async () => {
  const { invoke, stderr } = await fixture([]);
  expect(await invoke({ since: 'last week' })).toBe(1);
  expect(stderr.join('')).toContain('since must be a duration');
});

test('a duration reaching past the earliest date is a usage error, not a crash', async () => {
  const { invoke, stderr } = await fixture([]);
  expect(await invoke({ since: '99999999w' })).toBe(1);
  expect(stderr.join('')).toContain('earliest representable date');
});

test('--subject reports only that subject', async () => {
  const { invoke, stdout } = await fixture([{ subject: 'pr-1' }, { subject: 'pr-2' }]);
  expect(await invoke({ subject: 'pr-1', json: true })).toBe(0);
  const [instrument] =
    metricsReportSchema.parse(JSON.parse(stdout.join(''))).metrics[0]?.instruments ?? [];
  expect([instrument?.n, instrument?.latest.subject]).toEqual([1, 'pr-1']);
});
