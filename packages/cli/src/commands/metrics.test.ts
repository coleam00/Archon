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
  const runIds: string[] = [];
  for (const override of overrides) {
    const run = await store.createWorkflowRun({ workflow_name: 'count-prs', user_message: '' });
    runIds.push(run.id);
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
  return { invoke, stdout, stderr, store, runIds };
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

test('--compare splits by run start, prints both cohorts and labels the comparison observational', async () => {
  const score = { kind: 'score', unit: 'ratio' };
  const { invoke, stdout } = await fixture([
    { ...score, value: 1, subject: 'pr-1' },
    { ...score, value: 0, subject: 'pr-2' },
  ]);
  expect(await invoke({ compare: '2026-01-01' })).toBe(0);
  const text = stdout.join('');
  expect(text).toContain('factory.prs_merged  score/ratio  value 0.5  n 2  95% [');
  expect(text).toContain('cost no cost recorded, no tokens recorded over 2 runs found');
  expect(text).toContain(
    'compare at 2026-01-01T00:00:00.000Z: before none (n 0), after 0.5 (n 2  95% ['
  );
  expect(text).toContain('separated: no  straddling 0  unattributed 0');
  expect(text).toContain('The comparison is observational');

  stdout.length = 0;
  expect(await invoke({ compare: '2026-01-01', json: true })).toBe(0);
  const [instrument] =
    metricsReportSchema.parse(JSON.parse(stdout.join(''))).metrics[0]?.instruments ?? [];
  expect(instrument?.compare).toMatchObject({ before: { n: 0 }, after: { n: 2, value: 0.5 } });
});

test('a malformed --compare is a usage error', async () => {
  const { invoke, stderr } = await fixture([{}]);
  expect(await invoke({ compare: 'last release' })).toBe(1);
  expect(stderr.join('')).toContain('compare must be an ISO date');
});

test('--compare and --by-model together are a usage error', async () => {
  const { invoke, stderr } = await fixture([{}]);
  expect(await invoke({ compare: '2026-01-01', byModel: 'review' })).toBe(1);
  expect(stderr.join('')).toContain('compare and by-model cannot be combined');
});

test('--by-model with a node no producing run ran exits 2 and lists the AI nodes they ran', async () => {
  const { invoke, stderr, store, runIds } = await fixture([{}]);
  await store.persistWorkflowEvent({
    workflow_run_id: runIds[0] ?? '',
    event_type: 'node_completed',
    step_name: 'review__code',
    data: { type: 'agent', provider: 'codex', model: 'gpt-6.1-sol' },
  });
  expect(await invoke({ byModel: 'ship__review__code' })).toBe(2);
  expect(stderr.join('')).toContain(
    'no producing run ran an AI node "ship__review__code"; AI nodes they ran: review__code'
  );
});

test('--by-model prints a line per model label and labels the split observational', async () => {
  const { invoke, stdout, store, runIds } = await fixture([
    { subject: 'pr-1' },
    { subject: 'pr-2' },
  ]);
  const bindings = [
    { provider: 'codex', model: 'gpt-6.1-sol' },
    { provider: 'claude', model: 'opus', model_usage: { resolved: 'claude-opus-5-5' } },
  ];
  for (const [i, binding] of bindings.entries()) {
    await store.persistWorkflowEvent({
      workflow_run_id: runIds[i] ?? '',
      event_type: 'node_completed',
      step_name: 'review',
      data: { type: 'agent', ...binding },
    });
  }
  expect(await invoke({ byModel: 'review' })).toBe(0);
  const text = stdout.join('');
  expect(text).toContain('by model at review (unattributed 0):');
  expect(text).toContain(
    '    claude/claude-opus-5-5: value 2 (n 1)  vs rest 0  separated: no  requested opus;'
  );
  expect(text).toContain(
    '    codex/gpt-6.1-sol: value 2 (n 1)  vs rest 0  separated: no  requested gpt-6.1-sol;'
  );
  expect(text).toContain('The split is observational');
});
