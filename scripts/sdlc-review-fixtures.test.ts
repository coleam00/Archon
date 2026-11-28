import { providerRegistry } from '@archon/providers';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import { afterAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { removeTempTree, testTimeout } from '@archon/paths/test-utils';
import {
  dryRunWorkflow,
  type DryRunResult,
  type DryRunTraceEntry,
} from '../packages/workflows/src/dry-run';
import {
  parseFixtureFile,
  runFixtures,
  type ParsedFixtureFile,
} from '../packages/workflows/src/fixture-runner';
import { discoverWorkflowsWithConfig } from '../packages/workflows/src/workflow-discovery';
import type { WorkflowWithSource } from '../packages/workflows/src/schemas/workflow';
import { resolveTopLevelInputs } from '../packages/workflows/src/utils/workflow-requirements';

/**
 * The review pack's committed dry-run fixtures, executed (#6449). Each `*.stubs.yaml`
 * beside `archon-review.yaml` is first judged by the engine's fixture runner, which is
 * the verdict `workflow test review` prints, then dry-run again so this test can read
 * what a fixture declaration cannot state: which nodes were skipped, with what cause,
 * and what an executed node emitted. It lives in `scripts/` because it reads the SDLC
 * pack and the engine together; engine tests never read the pack.
 */
const repo = resolve(import.meta.dir, '..');
const fixtures = join(repo, '.archon', 'workflows', 'sdlc', 'review', 'fixtures');
const root = await mkdtemp(join(tmpdir(), 'archon-review-fixtures-'));
const originalHome = process.env.ARCHON_HOME;
process.env.ARCHON_HOME = join(root, 'home');
registerBuiltinProviders();
afterAll(async () => {
  if (originalHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalHome;
  await removeTempTree(root);
});

const WORKFLOW = 'archon-review';
const SOURCE_CONFIG = { load_default_workflows: false, load_default_commands: false };

/** The real workflow as `workflow test` loads it: discovery qualifies the pack's commands. */
async function reviewWorkflow(): Promise<WorkflowWithSource> {
  const discovered = await discoverWorkflowsWithConfig(
    repo,
    async () => ({ defaults: { loadDefaultWorkflows: false, loadDefaultCommands: false } }),
    providerRegistry
  );
  const workflow = discovered.workflows.find(candidate => candidate.workflow.name === WORKFLOW);
  if (workflow === undefined) {
    throw new Error(`discovery did not load ${WORKFLOW}: ${JSON.stringify(discovered.errors)}`);
  }
  return workflow;
}

function fixture(file: string): ParsedFixtureFile {
  return parseFixtureFile(readFileSync(join(fixtures, file), 'utf8'), file);
}

/** The fixture's stubs and declared inputs, dry-run against the live pack source. */
async function dryRun(workflow: WorkflowWithSource, file: string): Promise<DryRunResult> {
  const parsed = fixture(file);
  const inputs = resolveTopLevelInputs(workflow.workflow, parsed.declaration.inputs);
  return dryRunWorkflow({
    workflow: workflow.workflow,
    userMessage: '',
    cwd: repo,
    stubs: parsed.stubs,
    ...(inputs ? { inputs } : {}),
    execCode: parsed.execCode,
  });
}

function entry(result: DryRunResult, nodeId: string): DryRunTraceEntry {
  const found = result.trace.find(candidate => candidate.nodeId === nodeId);
  if (found === undefined) throw new Error(`node ${nodeId} is absent from the trace`);
  return found;
}

/** A node the default trigger rule skipped because an upstream node failed. */
function expectSkippedBehind(result: DryRunResult, nodeId: string, failed: string): void {
  expect(entry(result, nodeId)).toMatchObject({
    state: 'skipped',
    reason: 'trigger_rule',
    cause: { kind: 'upstream_failed', origin: failed },
  });
}

function failedNodes(result: DryRunResult): string[] {
  return result.trace.filter(node => node.state === 'failed').map(node => node.nodeId);
}

const VERIFIERS = ['verify-1', 'verify-2', 'verify-3'];
const SYNTHESIZE_FAILED = 'synthesize-failed.stubs.yaml';
const SCOPE_FAILED = 'scope-failed.stubs.yaml';
const READY = 'ready.stubs.yaml';
const NOT_READY = 'not-ready.stubs.yaml';
const FIXTURE_FILES = [NOT_READY, READY, SCOPE_FAILED, SYNTHESIZE_FAILED];

test(
  'every review fixture passes under the fixture runner, and this test names each one',
  async () => {
    // Freezes the pack's source and checks out a scratch worktree for the exec-code fixture.
    const report = await runFixtures({
      workflows: [await reviewWorkflow()],
      cwd: repo,
      target: 'review',
      sourceConfig: SOURCE_CONFIG,
    });
    expect(report.results.map(result => result.fixture)).toEqual(
      FIXTURE_FILES.map(file => `sdlc/review/fixtures/${file}`)
    );
    for (const result of report.results) {
      expect({ failure: result.failureReason, trace: result.trace }).toEqual({
        failure: undefined,
        trace: undefined,
      });
    }
    expect(report.failed).toBe(0);
  },
  testTimeout(30_000)
);

test('a failed synthesize is the one failure: settle and publish are skipped behind it', async () => {
  const result = await dryRun(await reviewWorkflow(), SYNTHESIZE_FAILED);
  expect(result.outcome).toBe('failed');
  expect(failedNodes(result)).toEqual(['synthesize']);
  expectSkippedBehind(result, 'settle', 'synthesize');
  expectSkippedBehind(result, 'publish', 'synthesize');
  for (const verifier of VERIFIERS) expectSkippedBehind(result, verifier, 'synthesize');
  // The join itself still runs: it binds nothing, so nothing in it can fail.
  expect(entry(result, 'verifiers-done').state).toBe('stubbed');
});

test('a failed scope skips synthesize, and settle is skipped rather than reading a node that never ran', async () => {
  const result = await dryRun(await reviewWorkflow(), SCOPE_FAILED);
  expect(result.outcome).toBe('failed');
  expect(failedNodes(result)).toEqual(['scope']);
  expectSkippedBehind(result, 'synthesize', 'scope');
  expectSkippedBehind(result, 'settle', 'scope');
  expectSkippedBehind(result, 'publish', 'scope');
  for (const verifier of VERIFIERS) expectSkippedBehind(result, verifier, 'scope');
});

test('a Ready verdict skips every verifier, and the real settle passes the verdict through', async () => {
  // The fixture declares exec-code, so the unstubbed join and settle scripts run.
  const result = await dryRun(await reviewWorkflow(), READY);
  expect(result.outcome).toBe('completed');
  expect(failedNodes(result)).toEqual([]);
  for (const verifier of VERIFIERS) {
    expect(entry(result, verifier)).toMatchObject({ state: 'skipped', reason: 'when_condition' });
  }
  const settle = entry(result, 'settle');
  expect(settle).toMatchObject({ state: 'completed', reason: 'executed locally' });
  // settle-review.ts on a Ready verdict emits synthesis's verdict unchanged.
  expect(JSON.parse(settle.output ?? '')).toEqual({
    ready: true,
    action: 'none',
    findings_summary: 'stub: no blocking finding',
    report: { type: 'archon_artifact', run_id: 'fixture-run', path: 'review/report.md' },
    discoveries: [],
    contract_left: [],
  });
  expect(entry(result, 'verifiers-done')).toMatchObject({
    state: 'completed',
    reason: 'executed locally',
  });
});

test('a not-Ready verdict runs all three verifiers before settle and publish', async () => {
  const result = await dryRun(await reviewWorkflow(), NOT_READY);
  expect(result.outcome).toBe('completed');
  expect(failedNodes(result)).toEqual([]);
  for (const node of [...VERIFIERS, 'verifiers-done', 'settle', 'publish']) {
    expect(entry(result, node).state).toBe('stubbed');
  }
});
