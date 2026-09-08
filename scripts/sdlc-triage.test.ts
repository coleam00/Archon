/** Real triage guard and publication code; only the gh process is replaced. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import {
  BUNDLED_COMMANDS,
  BUNDLED_WORKFLOWS,
  BUNDLED_WORKFLOW_OWNERS,
} from '../packages/workflows/src/defaults/bundled-defaults';
import { parseWorkflow } from '../packages/workflows/src/loader';
import { expandWorkflowIncludes } from '../packages/workflows/src/include-expander';
import { dryRunWorkflow } from '../packages/workflows/src/dry-run';
import { parseFixtureFile } from '../packages/workflows/src/fixture-runner';
import { qualifyWorkflowResources } from '../packages/workflows/src/packaged-workflow';

const REPO = join(import.meta.dir, '..');
const TRIAGE = join(REPO, '.archon/workflows/sdlc/triage');
const SCRIPT = join(TRIAGE, 'scripts/validate-contract.py');
const BASE = {
  route: 'deliver',
  summary: 'Current source confirms the work order.',
  contract: 'READY',
  design_first: false,
  complexity: 'small_bounded',
  proposed_edits: { title: '', body: '' },
  labels: ['archon-ready'],
  blocked_by: [] as string[],
  blocked_reason: '',
  issue_repo: '',
  issue_number: 0,
  issue_url: '',
};
const ISSUE = {
  issue_repo: 'explicit/other-repo',
  issue_number: 42,
  issue_url: 'https://github.com/explicit/other-repo/issues/42',
};
let root: string;
let fake: string;
let statePath: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archon triage '));
  fake = join(root, 'fake gh.py');
  statePath = join(root, 'state.json');
  await copyFile(SCRIPT, join(root, 'validate contract.py'));
  await copyFile(join(import.meta.dir, '__fixtures__/triage-fake-gh.py'), fake);
  await writeFile(join(root, 'triage.md'), '# Triage\nCurrent source: src/main.ts:12.\n');
  await writeFile(
    statePath,
    JSON.stringify({
      url: ISSUE.issue_url,
      number: 42,
      labels: [],
      issue_labels: ['unrelated-label', 'archon-blocked'],
      calls: [],
    })
  );
});
afterEach(async () => {
  await removeTempTree(root);
});

async function run(
  overrides: Record<string, unknown> = {},
  publish = 'false',
  mode = '',
  raw?: string
) {
  const proc = Bun.spawn(
    [
      'uv',
      'run',
      '--no-project',
      join(import.meta.dir, '__fixtures__/triage-process-seam.py'),
      join(root, 'validate contract.py'),
      fake,
    ],
    {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 4000,
      env: {
        ...process.env,
        ARTIFACTS_DIR: root,
        INPUTS_TRIAGE: raw ?? JSON.stringify({ ...BASE, ...overrides }),
        INPUTS_PUBLISH: publish,
        FAKE_GH_STATE: statePath,
        FAKE_GH_MODE: mode,
      },
    }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), code };
}
async function state() {
  return JSON.parse(await readFile(statePath, 'utf8')) as {
    labels: string[];
    issue_labels: string[];
    calls: string[][];
  };
}

const verdicts = ['READY', 'NEEDS_CONTRACT_WORK', 'BLOCKED', 'NO_ACTION'];
const routes = ['investigate', 'plan', 'deliver', 'no_action'];
const labels: Record<string, string> = {
  READY: 'archon-ready',
  NEEDS_CONTRACT_WORK: 'archon-needs-contract',
  BLOCKED: 'archon-blocked',
  NO_ACTION: 'archon-close',
};
describe('triage tuple cross-product against the real guard', () => {
  for (const contract of verdicts)
    for (const route of routes)
      for (const design_first of [false, true]) {
        const valid =
          (contract === 'READY' ? route !== 'no_action' : route === 'no_action') &&
          (!design_first || (contract === 'READY' && route === 'plan'));
        test(`${contract}/${route}/design_first=${String(design_first)} ${valid ? 'accepts' : 'refuses'}`, async () => {
          const result = await run({
            contract,
            route,
            design_first,
            labels: [
              design_first && contract === 'READY' ? 'archon-design-first' : labels[contract],
            ],
            proposed_edits:
              contract === 'NEEDS_CONTRACT_WORK'
                ? { title: 'Clarify scope', body: 'State acceptance.' }
                : BASE.proposed_edits,
            blocked_reason:
              contract === 'BLOCKED' ? 'Awaiting the external operator decision.' : '',
          });
          expect(result.code).toBe(valid ? 0 : 1);
          expect((await state()).calls).toEqual([]);
        });
      }
});

test('schema owner and script vocabulary conform, including the publisher return', async () => {
  const vocabulary = Bun.spawnSync(
    [
      'uv',
      'run',
      '--no-project',
      'python',
      '-c',
      'import json,runpy,sys; m=runpy.run_path(sys.argv[1]); print(json.dumps({k:m[k] for k in ("ROUTES","CONTRACTS","COMPLEXITIES")}))',
      SCRIPT,
    ],
    { stdout: 'pipe', stderr: 'pipe', timeout: 4000 }
  );
  expect(vocabulary.exitCode).toBe(0);
  const owner = JSON.parse(vocabulary.stdout.toString()) as {
    ROUTES: string[];
    CONTRACTS: string[];
    COMPLEXITIES: string[];
  };
  const doc = Bun.YAML.parse(await Bun.file(join(TRIAGE, 'archon-triage.yaml')).text()) as {
    nodes: {
      output_format: { properties: Record<string, { enum?: string[] }>; required: string[] };
    }[];
  };
  const [judge, validator] = doc.nodes.map(n => n.output_format);
  const { publication: _publication, ...properties } = validator.properties;
  expect(properties).toEqual(judge.properties);
  expect(judge.properties.contract.enum).toEqual(verdicts);
  expect(judge.properties.route.enum).toEqual(routes);
  expect(judge.properties.contract.enum).toEqual(owner.CONTRACTS);
  expect(judge.properties.route.enum).toEqual(owner.ROUTES);
  expect(judge.properties.complexity.enum).toEqual(owner.COMPLEXITIES);
  for (const schema of [judge, validator])
    expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
  for (const complexity of judge.properties.complexity.enum ?? [])
    expect((await run({ complexity })).code).toBe(0);
  const result = await run();
  expect(Object.keys(JSON.parse(result.stdout)).sort()).toEqual(
    Object.keys(validator.properties).sort()
  );
});

for (const [name, overrides, diagnostic] of [
  [
    'missing edits',
    { contract: 'NEEDS_CONTRACT_WORK', route: 'no_action' },
    'non-empty title and body',
  ],
  ['stale edits', { proposed_edits: { title: 'old', body: 'old' } }, 'must not propose edits'],
  ['typed edits', { proposed_edits: { title: 42, body: '' } }, 'string title and body'],
  ['missing blocked reason', { contract: 'BLOCKED', route: 'no_action' }, 'blocked_reason'],
  ['unqualified blocker', { blocked_by: [42] }, 'qualified HTTP(S)'],
  ['stale blocker', { blocked_by: ['https://tracker.example/ticket/7'] }, 'only BLOCKED'],
  ['wrong pack label', { labels: ['archon-blocked'] }, 'exactly the pack label'],
  ['duplicate label', { labels: ['archon-ready', 'archon-ready'] }, 'duplicates'],
  ['unknown complexity', { complexity: 'tiny' }, 'complexity is not one'],
  ['missing identity', { issue_number: 42 }, 'must identify one issue'],
  ['negative identity', { issue_number: -1 }, 'non-negative integer'],
  ['mismatched repository', { ...ISSUE, issue_repo: 'origin/repo' }, 'issue_url must match'],
  ['blank summary', { summary: '  ' }, 'summary must be non-empty'],
] satisfies [string, Record<string, unknown>, string][]) {
  test(`invalid input: ${name} fails before any forge call`, async () => {
    const result = await run(overrides, 'true');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(diagnostic);
    expect(result.stdout).toBe('');
    expect((await state()).calls).toEqual([]);
  });
}

test('BLOCKED accepts qualified cross-tracker references without fabricated issue numbers', async () => {
  expect(
    (
      await run({
        contract: 'BLOCKED',
        route: 'no_action',
        labels: ['archon-blocked'],
        blocked_reason: 'Upstream approval is pending.',
        blocked_by: ['https://tracker.example/tickets/7'],
      })
    ).code
  ).toBe(0);
});
test('missing and blank evidence fail against a valid tuple', async () => {
  for (const contents of ['', '   \n']) {
    await writeFile(join(root, 'triage.md'), contents);
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('no triage.md evidence');
  }
  await removeTempTree(join(root, 'triage.md'));
  expect((await run()).code).toBe(1);
});
test('malformed judgment and publish values fail clearly', async () => {
  expect((await run({}, 'false', '', '{invalid')).code).toBe(1);
  expect((await run({}, 'yes')).stderr).toContain('publish must be true or false');
});

test('publish off and non-tracker input make zero forge calls', async () => {
  expect((await run(ISSUE)).code).toBe(0);
  const prose = await run({}, 'true');
  expect(prose.code).toBe(0);
  expect(JSON.parse(prose.stdout).publication.published).toBe(false);
  expect((await state()).calls).toEqual([]);
});
test('an unrelated label added between the initial read and mutation survives', async () => {
  const result = await run(ISSUE, 'true', 'concurrent_unrelated');
  expect(result.stderr).toBe('');
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).publication.published).toBe(true);
  expect((await state()).issue_labels.sort()).toEqual(
    ['archon-ready', 'unrelated-label', 'area:concurrent/cli,api'].sort()
  );
});
test('explicit cross-repository identity, paginated labels and comma/slash labels survive publication', async () => {
  const initial = await state();
  initial.labels = [
    ...Array.from({ length: 305 }, (_, i) => `area:${String(i)}`),
    'area:cli,api',
    'area:cli/api',
    ...Object.values(labels),
    'archon-design-first',
  ];
  await writeFile(statePath, JSON.stringify({ ...initial, url: ISSUE.issue_url, number: 42 }));
  const result = await run(
    { ...ISSUE, labels: ['archon-ready', 'area:cli,api', 'area:cli/api', 'area:missing'] },
    'true'
  );
  expect(result.stderr).toBe('');
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).publication).toEqual({
    published: true,
    applied_labels: ['archon-ready', 'area:cli,api', 'area:cli/api'],
    skipped_labels: ['area:missing'],
  });
  const after = await state();
  expect(after.issue_labels.sort()).toEqual(
    ['archon-ready', 'area:cli,api', 'area:cli/api', 'unrelated-label'].sort()
  );
  expect(after.labels).toEqual(initial.labels);
  expect(after.calls.filter(c => c.includes('--method'))).toEqual([
    [
      'api',
      '--hostname',
      'github.com',
      'repos/explicit/other-repo/issues/42/labels',
      '--method',
      'POST',
      '--input',
      '-',
    ],
    [
      'api',
      '--hostname',
      'github.com',
      'repos/explicit/other-repo/issues/42/labels/archon-blocked',
      '--method',
      'DELETE',
    ],
  ]);
  expect(after.calls.every(c => c[3].startsWith('repos/explicit/other-repo/'))).toBe(true);
});
test('empty repository creates exactly the pack labels; a repeat makes no writes', async () => {
  const first = await run(ISSUE, 'true');
  expect(first.code).toBe(0);
  const after = await state();
  expect(after.labels.sort()).toEqual([...Object.values(labels), 'archon-design-first'].sort());
  const writes = after.calls.filter(c => c.includes('--method')).length;
  expect(writes).toBe(7);
  const second = await run(ISSUE, 'true');
  expect(second.code).toBe(0);
  expect(second.stdout).toBe(first.stdout);
  expect((await state()).calls.filter(c => c.includes('--method'))).toHaveLength(writes);
});
test('only stale pack labels are removed, including ready when moving to design-first', async () => {
  const initial = await state();
  initial.issue_labels = [...Object.values(labels), 'area:old/cli,api', 'archon-custom'];
  await writeFile(statePath, JSON.stringify(initial));
  const result = await run(
    { ...ISSUE, route: 'plan', design_first: true, labels: ['archon-design-first'] },
    'true'
  );
  expect(result.stderr).toBe('');
  expect(result.code).toBe(0);
  const after = await state();
  expect(after.issue_labels.sort()).toEqual(
    ['archon-design-first', 'area:old/cli,api', 'archon-custom'].sort()
  );
  expect(
    after.calls
      .filter(c => c.includes('DELETE'))
      .map(c => c[3])
      .sort()
  ).toEqual(
    Object.values(labels)
      .map(label => `repos/explicit/other-repo/issues/42/labels/${label}`)
      .sort()
  );
  const ready = await run(ISSUE, 'true');
  expect(ready.code).toBe(0);
  expect((await state()).issue_labels.sort()).toEqual(
    ['archon-ready', 'area:old/cli,api', 'archon-custom'].sort()
  );
  expect((await state()).calls.filter(c => c.includes('DELETE')).at(-1)?.[3]).toBe(
    'repos/explicit/other-repo/issues/42/labels/archon-design-first'
  );
});
for (const mode of [
  'noop_write',
  'drop_unrelated',
  'retain_stale',
  'concurrent_pack',
  'wrong_after',
  'partial_create',
  'partial_remove',
  'write_then_fail',
  'read_failure',
  'malformed_labels',
  'is_pr',
]) {
  test(`publication refuses ${mode} without a success output`, async () => {
    const result = await run(ISSUE, 'true', mode);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toBe('');
    if (mode === 'partial_create') expect((await state()).labels).toHaveLength(1);
    if (mode === 'write_then_fail') expect((await state()).issue_labels).toContain('archon-ready');
    if (mode === 'partial_remove') {
      expect((await state()).issue_labels.sort()).toEqual(
        ['archon-ready', 'archon-blocked', 'unrelated-label'].sort()
      );
      expect(result.stderr).toContain('synthetic remove failure after addition');
      expect((await run(ISSUE, 'true')).code).toBe(0);
      expect((await state()).issue_labels.sort()).toEqual(['archon-ready', 'unrelated-label']);
    }
  });
}
test('mismatched pre-write identity refuses before even creating repository labels', async () => {
  const result = await run(ISSUE, 'true', 'wrong_before');
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('identity mismatch');
  expect((await state()).calls).toHaveLength(1);
});

for (const file of readdirSync(join(TRIAGE, 'fixtures'))) {
  test(`fixture judgment executes the real validator: ${file}`, async () => {
    const fixture = parseFixtureFile(await Bun.file(join(TRIAGE, 'fixtures', file)).text(), file);
    const judgment = fixture.stubs.triage;
    if (!judgment || typeof judgment !== 'object' || Array.isArray(judgment))
      throw new Error('Expected a structured judgment');
    const result = await run(judgment);
    expect(result.code).toBe(0);
    if (fixture.stubs['validate-contract']) {
      expect(JSON.parse(result.stdout)).toEqual(fixture.stubs['validate-contract']);
    }
  });
}

test('real validated negative judgments skip every engineering node in composed ship', async () => {
  const definitions = new Map(
    Object.entries(BUNDLED_WORKFLOWS)
      .filter(([name]) => BUNDLED_WORKFLOW_OWNERS[name]?.pack === 'sdlc')
      .map(([name, text]) => {
        const parsed = parseWorkflow(text, name);
        if (!parsed.workflow) throw new Error(parsed.error.error);
        const owner = BUNDLED_WORKFLOW_OWNERS[name];
        if (!owner) throw new Error(`Missing workflow owner: ${name}`);
        qualifyWorkflowResources(parsed.workflow, { source: 'bundled', ...owner });
        return [name, parsed.workflow];
      })
  );
  const expanded = expandWorkflowIncludes(definitions, new Map(Object.entries(BUNDLED_COMMANDS)));
  const ship = expanded.workflows.get('archon-ship');
  if (!ship) throw new Error(JSON.stringify(expanded.errors));
  for (const file of [
    'needs-contract-work',
    'blocked',
    'external-blocker',
    'duplicate',
    'multi-item-refusal',
  ]) {
    const fixture = parseFixtureFile(
      await Bun.file(join(TRIAGE, 'fixtures', `${file}.stubs.yaml`)).text(),
      file
    );
    const judgment = fixture.stubs.triage;
    if (!judgment || typeof judgment !== 'object' || Array.isArray(judgment))
      throw new Error('Expected a structured judgment');
    const validated = await run(judgment);
    expect(validated.code).toBe(0);
    const result = await dryRunWorkflow({
      workflow: ship,
      cwd: root,
      userMessage: '',
      defaultStubs: true,
      stubs: { triage__triage: judgment, 'triage__validate-contract': validated.stdout },
    });
    expect(result.outcome).toBe('completed');
    const engineering = result.trace.filter(n =>
      /^(inv__|planned__|deliver__|gate-)/.test(n.nodeId)
    );
    expect(engineering.length).toBeGreaterThan(0);
    expect(engineering.every(n => n.state === 'skipped')).toBe(true);
    expect(result.trace.find(n => n.nodeId === 'outcome')?.state).toBe('stubbed');
  }
});
