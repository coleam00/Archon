import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectRefForCodebase } from '@archon/core/operations/attention-queue';
import { trackTempRoots } from '@archon/paths/test-utils';
import { itemMetricsReportSchema } from '@archon/workflows/schemas/item-metric';
import type { ItemMerge } from '@archon/workflows/schemas/item-merge';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { DEFAULT_WORKFLOW_SOURCE_CONFIG } from '@archon/workflows/workflow-source';
import type { LiveWorkflowSourceRoots } from '@archon/workflows/workflow-source/roots';
import { providerRegistry } from '@archon/providers';
import { loadConfig } from '@archon/core/config/config-loader';
import { metricsReportSchema } from '@archon/workflows/schemas/metric';
import { metricsCommand, type MetricsCommandOptions } from './metrics';
import {
  createInMemoryWorkflowHostStore,
  createInMemoryWorkflowStore,
} from '../test-support/workflow-store';

const now = new Date('2026-10-30T12:00:00Z');
const trackTempRoot = trackTempRoots();

/** One run per entry, each recording a `prs` count for no subject, overridden by the entry. */
async function fixture(overrides: Record<string, unknown>[]) {
  const records = createInMemoryWorkflowHostStore();
  const store = createInMemoryWorkflowStore(records);
  const runIds: string[] = [];
  // A `dimensions` override is the record's entry in its output's `metric_dimensions`.
  for (const { dimensions, ...override } of overrides) {
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
          ...(dimensions === undefined ? {} : { metric_dimensions: [dimensions] }),
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

test('--since 90m selects metrics from the last ninety minutes', async () => {
  const { invoke, stdout } = await fixture([
    { at: '2026-10-30T10:29:59Z' },
    { at: '2026-10-30T10:30:00Z' },
  ]);
  expect(await invoke({ since: '90m', json: true })).toBe(0);
  const report = metricsReportSchema.parse(JSON.parse(stdout.join('')));
  expect(report.window).toEqual({
    since: '2026-10-30T10:30:00.000Z',
    until: now.toISOString(),
  });
  expect(report.metrics[0]?.instruments[0]?.n).toBe(1);
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

test('an empty --by-model is a usage error', async () => {
  const { invoke, stderr } = await fixture([{}]);
  expect(await invoke({ byModel: '' })).toBe(1);
  expect(stderr.join('')).toContain('by-model needs a node id');
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

test('--by-dimension with --compare prints a line per value with its cohorts', async () => {
  const { invoke, stdout } = await fixture([
    { dimensions: { route: 'plan' } },
    { dimensions: { route: 'deliver' }, value: 3 },
    {},
  ]);
  expect(await invoke({ byDimension: 'route', compare: '2026-01-01' })).toBe(0);
  const text = stdout.join('');
  expect(text).toContain('  by route:\n    deliver: value 3 (n 1)  vs rest 1  separated: no;');
  expect(text).toContain('    plan: value 2 (n 1)  vs rest -1  separated: no;');
  expect(text).toContain('    (none): value 2 (n 1)  vs rest -3  separated: no;');
  expect(text).toContain(
    '      compare at 2026-01-01T00:00:00.000Z: before none (n 0), after 3 (n 1)'
  );
  expect(text).toContain('each value covers different work');
  expect(text).toContain('The comparison is observational');
});

test('--by-dimension with a key no record carries exits 2 and lists the keys they carry', async () => {
  const { invoke, stderr } = await fixture([{ dimensions: { route: 'plan' } }]);
  expect(await invoke({ byDimension: 'size' })).toBe(2);
  expect(stderr.join('')).toContain(
    'no record carries a dimension "size"; dimensions they carry: route'
  );
});

test('the headline is the newest judge model, and each instrument line names its models', async () => {
  const judge = { kind: 'score', unit: 'ratio', instrument: 'judge-v1', instrument_node: 'judge' };
  const { invoke, stdout, store, runIds } = await fixture([
    { ...judge, value: 0.2, subject: 'pr-1', at: '2026-10-28T00:00:00Z' },
    { ...judge, value: 0.8, subject: 'pr-1', at: '2026-10-29T00:00:00Z' },
  ]);
  const judges = [
    { provider: 'claude', model: 'claude-opus-5-5' },
    { provider: 'codex', model: 'gpt-6.1-sol' },
  ];
  for (const [i, binding] of judges.entries()) {
    await store.persistWorkflowEvent({
      workflow_run_id: runIds[i] ?? '',
      event_type: 'node_completed',
      step_name: 'judge',
      data: { type: 'agent', ...binding },
    });
  }
  expect(await invoke({})).toBe(0);
  const lines = stdout.join('').split('\n');
  expect(lines[1]).toBe(
    'factory.prs_merged  score/ratio  value 0.8  n 1  latest 0.8 at 2026-10-29T00:00:00.000Z (pr-1)  [judge-v1 on codex/gpt-6.1-sol]'
  );
  expect(lines).toContain(
    '  judge-v1 on claude/claude-opus-5-5: value 0.2  n 1  latest 0.2 at 2026-10-28T00:00:00.000Z (pr-1)'
  );
});

test('a headline judge label containing a comma is not two labels', async () => {
  const judge = { kind: 'score', unit: 'ratio', instrument: 'judge-v1', instrument_node: 'judge' };
  const { invoke, stdout, store, runIds } = await fixture([
    { ...judge, value: 0.2, subject: 'pr-1', at: '2026-10-28T00:00:00Z' },
    { ...judge, value: 0.8, subject: 'pr-1', at: '2026-10-29T00:00:00Z' },
  ]);
  const judgeSteps = [
    { run: 0, model: 'a', iteration: 1 },
    { run: 0, model: 'b', iteration: 2 },
    { run: 1, model: 'a,codex/b', iteration: 1 },
  ];
  for (const { run, model, iteration } of judgeSteps) {
    await store.persistWorkflowEvent({
      workflow_run_id: runIds[run] ?? '',
      event_type: 'node_completed',
      step_name: 'judge',
      data: {
        type: 'agent',
        provider: 'codex',
        model,
        invocation: { loopPath: [{ groupId: 'rounds', iteration }] },
      },
    });
  }
  expect(await invoke({})).toBe(0);
  const lines = stdout.join('').split('\n');
  expect(lines[1]).toContain('value 0.8');
  expect(lines[1]).toContain('[judge-v1 on codex/a,codex/b]');
});

test('with --project, the item metrics a pack declares are reported over the window with no pack script', async () => {
  const { store } = await fixture([]);
  const records = createInMemoryWorkflowHostStore();
  const codebase = await records.codebases.createCodebase({ name: 'web', default_cwd: '/web' });
  const projectKey = projectRefForCodebase(codebase).key;
  // Three items: a merged after two review rounds, b merged after one, c not merged.
  const items = ['a', 'b', 'c'].map(key => ({ id: `item-${key}`, projectKey, key }));
  const rounds: Record<string, string[]> = {
    a: ['build', 'archon-review', 'archon-review'],
    b: ['build', 'archon-review'],
    c: ['build', 'archon-review'],
  };
  const runs = new Map<string, WorkflowRun[]>();
  for (const item of items)
    runs.set(
      item.key,
      await Promise.all(
        (rounds[item.key] ?? []).map(workflow =>
          store.createWorkflowRun({ workflow_name: workflow, user_message: '' })
        )
      )
    );
  const merged = (key: string): ItemMerge | null =>
    key === 'c'
      ? null
      : {
          change: `https://forge.example/web/pull/${key}`,
          commit: null,
          at: '2026-10-29T00:00:00.000Z',
          recordedAt: '2026-10-29T00:00:00.000Z',
          via: 'cli',
          fromRun: null,
        };
  const itemStore = {
    ...store,
    listItemsInWindow: async () => items,
    getItemRuns: async (_project: string, key: string) => {
      const item = items.find(entry => entry.key === key);
      return item ? { item, runs: runs.get(key) ?? [], descendantIds: [] } : null;
    },
    listItemRulings: async () => [],
    getItemMerge: async (id: string) => merged(id.slice('item-'.length)),
    getItemLanding: async () => null,
    listQueuedItemStarts: async () => [],
    listSkippedItemStarts: async () => [],
    getInstallHold: async () => null,
    listHeldItemStarts: async () => [],
    listItemLinks: async () => [],
  };
  const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-item-metrics-')));
  await mkdir(join(root, 'factory', '.shared'), { recursive: true });
  await writeFile(
    join(root, 'factory', '.shared', 'item-metrics.json'),
    JSON.stringify({
      metrics: [
        { name: 'factory.merge_rate', op: 'share', where: { merged: true } },
        {
          name: 'factory.review_rounds_per_merged_item',
          op: 'count',
          of: 'runs',
          runs: { workflow: ['archon-review'] },
          items: { merged: true },
        },
      ],
    })
  );
  const host = {
    records,
    deps: {
      store: itemStore,
      providers: providerRegistry,
      loadConfig,
      getAgentProvider: (): never => {
        throw new Error('No provider');
      },
    },
  };
  const stdout: string[] = [];
  const io = {
    now,
    stdout: async (text: unknown) => {
      stdout.push(String(text));
    },
    stderr: async () => {},
    sourceRoots: {
      kind: 'live',
      config: { ...DEFAULT_WORKFLOW_SOURCE_CONFIG, load_default_workflows: false },
      project: null,
      globalWorkflows: root,
      globalCommands: join(root, 'commands'),
      globalScripts: join(root, 'scripts'),
      bundledWorkflows: join(root, 'bundled'),
      installed: { kind: 'receipts', pluginsDir: join(root, 'plugins') },
    } satisfies LiveWorkflowSourceRoots,
  };
  expect(await metricsCommand(host, undefined, { project: 'web', json: true }, io)).toBe(0);
  const report = JSON.parse(stdout.join('')) as { item_metrics: unknown };
  const itemMetrics = itemMetricsReportSchema.parse(report.item_metrics);
  expect(itemMetrics.items).toBe(3);
  expect(itemMetrics.packs).toEqual([
    {
      pack: 'factory',
      source: 'global',
      metrics: [
        {
          name: 'factory.merge_rate',
          op: 'share',
          value: 2 / 3,
          numerator: 2,
          denominator: 3,
        },
        { name: 'factory.review_rounds_per_merged_item', op: 'count', value: 1.5, total: 3, n: 2 },
      ],
    },
  ]);
  // Without a project there is no item to read.
  stdout.length = 0;
  expect(await metricsCommand(host, undefined, { json: true }, io)).toBe(0);
  expect(JSON.parse(stdout.join(''))).toMatchObject({ item_metrics: null });
});
