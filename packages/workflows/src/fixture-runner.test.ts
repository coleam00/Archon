/** Tests for the declared-data dry-run fixture runner (#2772). */
import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree, trackTempRoots } from '@archon/paths/test-utils';

// Capture-cost control, same lever and same reason as `subrun.test.ts` (#2882): every
// `runFixtures` call takes one source capture, and a capture copies and digests the
// repo's OWN bundled scope — `.archon/workflows` plus `.archon/commands`, ~178 files —
// alongside the handful of fixture files the test wrote. Thirty captures in this file
// is ~5,300 incidental file copies, and that bulk IO is what puts this suite at Bun's
// 5000ms budget on a contended Windows runner. No test here reads bundled CONTENT: the
// bundled SCOPE tests drive `sourceRoots.bundledWorkflows`, which is a discovery root
// this file already points at a temp directory. Pointing the two bundle getters at an
// owned EMPTY tree keeps the bundled scope's semantics intact — an existing directory
// is still scanned, still copied, still recorded in the manifest — while removing the
// file fan-out.
// NB: point these one level DEEP (`<root>/defaults`) — captureWorkflowSource copies
// dirname(getDefault*Path()), so the getter's PARENT must be the owned empty tree.
const bundledDefaultsRoot = join(tmpdir(), `fixture-runner-test-empty-bundled-${process.pid}`);
await mkdir(join(bundledDefaultsRoot, 'defaults'), { recursive: true });
afterAll(() => removeTempTree(bundledDefaultsRoot));
const realArchonPaths = await import('@archon/paths');
mock.module('@archon/paths', () => ({
  ...realArchonPaths,
  getDefaultWorkflowsPath: () => join(bundledDefaultsRoot, 'defaults'),
  getDefaultCommandsPath: () => join(bundledDefaultsRoot, 'defaults'),
}));

import { execFileAsync, resolveBashPath } from '@archon/git';
import { parseWorkflow } from './loader';
import { expandWorkflowIncludes } from './include-expander';
import type { WorkflowWithSource } from './schemas/workflow';
import {
  DEFAULT_WORKFLOW_SOURCE_CONFIG,
  liveSourceRoots,
  type WorkflowSourceConfig,
  type WorkflowSourceRoots,
} from './workflow-source';

/** Load the temp project's on-disk workflows so targets match discovery's output shape. */
function workflowsOnDisk(cwd: string, names: string[], pack = 'pack'): WorkflowWithSource[] {
  return names.map(name => {
    const path = join(cwd, '.archon', 'workflows', pack, `${name}.yaml`);
    const parsed = parseWorkflow(readFileSync(path, 'utf8'), `${name}.yaml`);
    if (!parsed.workflow) throw new Error(parsed.error.error);
    const raw = new Map([[parsed.workflow.name, parsed.workflow]]);
    const expanded = expandWorkflowIncludes(raw);
    return {
      workflow: expanded.workflows.get(name) ?? parsed.workflow,
      source: 'project' as const,
    };
  });
}
import {
  formatFixtureReport,
  parseFixtureFile,
  runFixtures as runFixturesFromSource,
  type FixtureReport,
  type RunFixturesOptions,
} from './fixture-runner';

/** The file's one temp-root creator, so every fixture tree is tracked for teardown. */
const trackTempRoot = trackTempRoots();
function makeTempProject(prefix = 'fixture-runner-'): string {
  return trackTempRoot(mkdtempSync(join(tmpdir(), prefix)));
}

function isolatedSourceRoots(cwd: string): WorkflowSourceRoots {
  const roots = liveSourceRoots(cwd);
  return {
    ...roots,
    globalWorkflows: join(cwd, '.empty', 'global-workflows'),
    bundledWorkflows: join(cwd, '.empty', 'bundled-workflows'),
  };
}

/**
 * `sourceConfig` is required on the real option type so no production caller can freeze a
 * narrower set of directories than the run would. Most tests here are not about command
 * policy, so the wrapper makes that one choice — the standard folders — on their behalf.
 */
async function runFixtures(
  options: Omit<RunFixturesOptions, 'sourceConfig'> & { sourceConfig?: WorkflowSourceConfig }
): Promise<FixtureReport> {
  return runFixturesFromSource({
    ...options,
    sourceConfig: options.sourceConfig ?? DEFAULT_WORKFLOW_SOURCE_CONFIG,
    // Default to empty global/bundled scopes so a test cannot read the real ones; a test
    // that is specifically about cross-scope behavior passes its own populated roots.
    sourceRoots: options.sourceRoots ?? isolatedSourceRoots(options.cwd),
  });
}

interface TempFixtureOptions {
  workflowName?: string;
  fixtureName?: string;
  body: string;
  /** Workflow yaml written next to fixtures/ — defaults to a one-node stub target. */
  workflowYaml?: string;
  /** Existing directory to write into, for a tree whose lifetime is not one test. */
  cwd?: string;
}

function writeTempProject(options: TempFixtureOptions): { cwd: string; fixturePath: string } {
  const cwd = options.cwd ?? makeTempProject();
  const packDir = join(cwd, '.archon', 'workflows', 'pack');
  const fixturesDir = join(packDir, 'fixtures');
  mkdirSync(fixturesDir, { recursive: true });
  const name = options.workflowName ?? 'test-wf';
  writeFileSync(
    join(packDir, `${name}.yaml`),
    options.workflowYaml ??
      `name: ${name}\ndescription: test\nnodes:\n  - id: node-a\n    prompt: hello\n`
  );
  const fixturePath = join(fixturesDir, `${options.fixtureName ?? 'happy'}.stubs.yaml`);
  writeFileSync(fixturePath, options.body);
  return { cwd, fixturePath };
}

describe('parseFixtureFile', () => {
  it('splits reserved keys from node stubs and applies defaults', () => {
    const parsed = parseFixtureFile(
      ['fixture:', '  expect: completed', 'node-a: "stub"', 'exec-code: false'].join('\n'),
      'x.stubs.yaml'
    );
    expect(parsed.declaration.expect).toBe('completed');
    expect(parsed.declaration.reached).toBeUndefined();
    expect(parsed.execCode).toBe(false);
    expect(parsed.stubs).toEqual({ 'node-a': 'stub' });
  });

  it('requires fail-node when expect is failed', () => {
    expect(() =>
      parseFixtureFile(['fixture:', '  expect: failed', 'node-a: "stub"'].join('\n'), 'x')
    ).toThrow('fail-node is required');
  });

  it('rejects non-boolean exec-code loudly (reserved-key collision guard)', () => {
    expect(() =>
      parseFixtureFile(['exec-code: yes-please', 'node-a: "stub"'].join('\n'), 'x')
    ).toThrow("'exec-code' must be true or false");
  });

  it('accepts every dry-run outcome the producer can emit (#2772)', () => {
    for (const outcome of ['completed', 'failed', 'paused', 'cancelled'] as const) {
      const body =
        outcome === 'failed'
          ? ['fixture:', '  expect: failed', '  fail-node: node-a'].join('\n')
          : ['fixture:', `  expect: ${outcome}`].join('\n');
      expect(parseFixtureFile(body, 'x').declaration.expect).toBe(outcome);
    }
  });
});

describe('runFixtures', () => {
  const passingBody = ['fixture:', '  expect: completed', 'node-a: "stub output"', ''].join('\n');

  it('passes a fixture whose declared outcome matches the dry-run outcome', async () => {
    const { cwd } = writeTempProject({ body: passingBody });
    const report = await runFixtures({
      workflows: [workflowsOnDisk(cwd, ['test-wf'])[0]],
      cwd,
    });
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.results[0].outcome).toBe('completed');
  });

  it('requires declared nodes to complete or be stubbed', async () => {
    const { cwd } = writeTempProject({
      workflowYaml:
        'name: test-wf\ndescription: test\nnodes:\n' +
        '  - id: node-a\n    bash: echo yes\n' +
        '  - id: node-b\n    prompt: later\n    depends_on: [node-a]\n    when: "$node-a.output == \'no\'"\n',
      body: ['fixture:', '  reached: [node-b]', 'node-a: "yes"', 'node-b: "must run"'].join('\n'),
    });
    const report = await runFixtures({
      workflows: [workflowsOnDisk(cwd, ['test-wf'])[0]],
      cwd,
    });

    expect(report.failed).toBe(1);
    expect(report.results[0].failureReason).toBe('required nodes did not complete: node-b');
  });

  // `reached:` used to be chained after the `expect: failed` branch, so declaring both
  // silently evaluated neither — the declaration proved nothing while looking like a guard.
  it('enforces reached nodes under expect: failed', async () => {
    const { cwd } = writeTempProject({
      workflowYaml:
        'name: test-wf\ndescription: test\nnodes:\n' +
        '  - id: node-a\n    prompt: hello\n' +
        '  - id: node-b\n    prompt: $NODE_OUTPUT.node-a.missing\n    depends_on: [node-a]\n' +
        '  - id: node-c\n    prompt: never\n    depends_on: [node-b]\n',
      body: [
        'fixture:',
        '  expect: failed',
        '  fail-node: node-b',
        '  reached: [node-c]',
        'node-a: "stub"',
      ].join('\n'),
    });
    const report = await runFixtures({
      workflows: [workflowsOnDisk(cwd, ['test-wf'])[0]],
      cwd,
    });

    expect(report.failed).toBe(1);
    expect(report.results[0].outcome).toBe('failed');
    expect(report.results[0].failureReason).toBe('required nodes did not complete: node-c');
  });

  it('passes an expected failure whose reached nodes all ran before it', async () => {
    const { cwd } = writeTempProject({
      workflowYaml:
        'name: test-wf\ndescription: test\nnodes:\n' +
        '  - id: node-a\n    prompt: hello\n' +
        '  - id: node-b\n    prompt: $NODE_OUTPUT.node-a.missing\n    depends_on: [node-a]\n',
      body: [
        'fixture:',
        '  expect: failed',
        '  fail-node: node-b',
        '  reached: [node-a]',
        'node-a: "stub"',
      ].join('\n'),
    });
    const report = await runFixtures({
      workflows: [workflowsOnDisk(cwd, ['test-wf'])[0]],
      cwd,
    });

    expect(report.passed).toBe(1);
  });

  // The two checks are independent: satisfying `reached:` must not excuse a node that ran
  // without a stub anywhere else in the graph. A durable wait holds the outcome at
  // `paused`, which is the case where the stub-completeness check is the one that speaks.
  it('still reports missing stubs on a fixture whose reached nodes all ran', async () => {
    const { cwd } = writeTempProject({
      workflowYaml:
        'name: test-wf\ndescription: test\nnodes:\n' +
        '  - id: node-a\n    prompt: hello\n' +
        '  - id: node-b\n    prompt: b\n    depends_on: [node-a]\n' +
        '  - id: node-c\n    prompt: c\n    depends_on: [node-a]\n' +
        '  - id: hold\n    wait:\n      duration_ms: 60000\n    depends_on: [node-b, node-c]\n' +
        '    trigger_rule: all_done\n',
      body: [
        'fixture:',
        '  expect: paused',
        '  reached: [node-b]',
        'node-a: "stub"',
        'node-b: "stub"',
      ].join('\n'),
    });
    const report = await runFixtures({
      workflows: [workflowsOnDisk(cwd, ['test-wf'])[0]],
      cwd,
    });

    expect(report.failed).toBe(1);
    expect(report.results[0].failureReason).toBe('reached nodes without stubs: node-c');
  });

  it('passes an expected failure that fails on exactly the declared node', async () => {
    // A `when:` referencing a missing producer makes node-b fail deterministically.
    const { cwd } = writeTempProject({
      workflowYaml:
        'name: test-wf\ndescription: test\nnodes:\n' +
        '  - id: node-a\n    prompt: hello\n' +
        '  - id: node-b\n    prompt: $NODE_OUTPUT.node-a.missing\n    depends_on: [node-a]\n',
      body: ['fixture:', '  expect: failed', '  fail-node: node-b', 'node-a: "stub"'].join('\n'),
    });
    const report = await runFixtures({
      workflows: [workflowsOnDisk(cwd, ['test-wf'])[0]],
      cwd,
    });
    expect(report.passed).toBe(1);
    expect(report.results[0].outcome).toBe('failed');
  });

  it('fails a fixture whose declared outcome diverges from the dry run', async () => {
    const { cwd } = writeTempProject({
      workflowYaml:
        'name: test-wf\ndescription: test\nnodes:\n' +
        '  - id: node-a\n    prompt: hello\n' +
        '  - id: node-b\n    prompt: $NODE_OUTPUT.node-a.missing\n    depends_on: [node-a]\n',
      body: 'node-a: "stub"\n',
    });
    const report = await runFixtures({
      workflows: [workflowsOnDisk(cwd, ['test-wf'])[0]],
      cwd,
    });
    expect(report.failed).toBe(1);
    expect(report.results[0].failureReason).toContain(
      'expected completed, dry-run reported failed'
    );
  });

  it('rejects a completing fixture that reached nodes without stubs', async () => {
    const { cwd } = writeTempProject({
      workflowYaml:
        'name: test-wf\ndescription: test\nnodes:\n' +
        '  - id: node-a\n    prompt: hi\n' +
        '  - id: node-b\n    prompt: there\n    depends_on: [node-a]\n',
      body: 'node-a: "stub"\n',
    });
    const report = await runFixtures({
      workflows: [workflowsOnDisk(cwd, ['test-wf'])[0]],
      cwd,
    });
    expect(report.failed).toBe(1);
    expect(report.results[0].missingStubs).toEqual(['node-b']);
  });

  // The exact `workflow test` regression this fix closes (#2807): before it, a new
  // `all_done` join with no stub failed `dryRunWorkflow`'s own outcome AND this
  // independent gate. `dryRunWorkflow`'s outcome is now `completed`, but that alone is
  // not the fix — this fixture must also stop treating the tolerated node as blocking.
  it('passes a completing fixture whose only missing stub is tolerated by an all_done join (#2869)', async () => {
    const { cwd } = writeTempProject({
      workflowYaml:
        'name: test-wf\ndescription: test\nnodes:\n' +
        '  - id: node-a\n    prompt: hi\n' +
        '  - id: node-b\n    prompt: there\n    depends_on: [node-a]\n' +
        '    trigger_rule: all_done\n',
      body: 'node-a: "stub"\n',
    });
    const report = await runFixtures({
      workflows: [workflowsOnDisk(cwd, ['test-wf'])[0]],
      cwd,
    });

    expect(report.passed).toBe(1);
    expect(report.results[0].outcome).toBe('completed');
    expect(report.results[0].missingStubs).toEqual(['node-b']);
    // The gap is reported as tolerated, not merely as missing: a reader of a
    // PASSING fixture can otherwise not tell the two apart.
    expect(report.results[0].toleratedMissingStubs).toEqual(['node-b']);
    expect(formatFixtureReport(report)).toContain(
      'note: unstubbed all_done join(s) tolerated — node-b'
    );
  });

  it('does not mark an ordinary missing stub as tolerated (#2869)', async () => {
    const { cwd } = writeTempProject({
      workflowYaml:
        'name: test-wf\ndescription: test\nnodes:\n' +
        '  - id: node-a\n    prompt: hi\n' +
        '  - id: node-b\n    prompt: there\n    depends_on: [node-a]\n',
      body: 'node-a: "stub"\n',
    });
    const report = await runFixtures({
      workflows: [workflowsOnDisk(cwd, ['test-wf'])[0]],
      cwd,
    });

    // Without the join, the unstubbed node fails the dry run itself, so the
    // fixture never reaches the stub gate — and nothing is tolerated.
    expect(report.failed).toBe(1);
    expect(report.results[0].outcome).toBe('failed');
    expect(report.results[0].missingStubs).toEqual(['node-b']);
    expect(report.results[0].toleratedMissingStubs).toEqual([]);
    expect(formatFixtureReport(report)).not.toContain('tolerated');
  });

  // `loop:` is the node shape #2869 left behind: it resolves its own stub inside
  // simulateLoop and never reaches the single-node gate the tolerance was added to.
  // The fixture gate has no loop branch, so this proves the end-to-end path a user
  // hits — `workflow test` on an unstubbed all_done loop — rather than a second
  // filter (#2966).
  it('passes a fixture whose only missing stub is an all_done loop node (#2966)', async () => {
    const { cwd } = writeTempProject({
      workflowYaml:
        'name: test-wf\ndescription: test\nnodes:\n' +
        '  - id: node-a\n    prompt: hi\n' +
        '  - id: node-b\n    depends_on: [node-a]\n    trigger_rule: all_done\n' +
        '    loop:\n      prompt: refine\n      until_bash: "true"\n      max_iterations: 3\n',
      body: 'node-a: "stub"\n',
    });
    const report = await runFixtures({
      workflows: [workflowsOnDisk(cwd, ['test-wf'])[0]],
      cwd,
    });

    expect(report.passed).toBe(1);
    expect(report.results[0].outcome).toBe('completed');
    expect(report.results[0].missingStubs).toEqual(['node-b']);
    expect(report.results[0].toleratedMissingStubs).toEqual(['node-b']);
  });

  it('warns on unused stubs without failing', async () => {
    const { cwd } = writeTempProject({
      body: ['node-a: "stub"', 'unused-node: "never reached"'].join('\n'),
    });
    const report = await runFixtures({
      workflows: [workflowsOnDisk(cwd, ['test-wf'])[0]],
      cwd,
    });
    expect(report.passed).toBe(1);
    expect(report.results[0].unusedStubs).toEqual(['unused-node']);
    expect(formatFixtureReport(report)).toContain('warning: unused stubs');
  });

  it('passes declaration inputs through to the dry run', async () => {
    const { cwd } = writeTempProject({
      workflowYaml:
        'name: test-wf\ndescription: test\ninputs:\n  branch:\n    required: true\nnodes:\n' +
        '  - id: node-a\n    prompt: branch=$INPUTS.branch\n',
      body: ['fixture:', '  inputs:', '    branch: task-42', 'node-a: "branch=task-42"'].join('\n'),
    });
    const report = await runFixtures({
      workflows: [workflowsOnDisk(cwd, ['test-wf'])[0]],
      cwd,
    });
    expect(report.passed).toBe(1);
  });

  it("rejects fixture inputs that the workflow doesn't declare", async () => {
    const { cwd } = writeTempProject({
      workflowYaml:
        'name: test-wf\ndescription: test\ninputs:\n  branch:\n    default: main\nnodes:\n' +
        '  - id: node-a\n    prompt: branch=$INPUTS.branch\n',
      body: ['fixture:', '  inputs:', '    typo: task-42', 'node-a: "stub"'].join('\n'),
    });
    const report = await runFixtures({
      workflows: [workflowsOnDisk(cwd, ['test-wf'])[0]],
      cwd,
    });

    expect(report.failed).toBe(1);
    expect(report.results[0].failureReason).toContain("does not declare input 'typo'");
  });

  it('rejects a fixture that omits a required workflow input', async () => {
    const { cwd } = writeTempProject({
      workflowYaml:
        'name: test-wf\ndescription: test\ninputs:\n  branch:\n    required: true\nnodes:\n' +
        '  - id: node-a\n    prompt: branch=$INPUTS.branch\n',
      body: 'node-a: "stub"',
    });
    const report = await runFixtures({
      workflows: [workflowsOnDisk(cwd, ['test-wf'])[0]],
      cwd,
    });

    expect(report.failed).toBe(1);
    expect(report.results[0].failureReason).toContain("requires input 'branch'");
  });

  it('fails when a node prompt omits the declared resolved-text fragment', async () => {
    const { cwd } = writeTempProject({
      workflowYaml:
        'name: test-wf\ndescription: test\ninputs:\n  target:\n    default: ""\nnodes:\n' +
        '  - id: node-a\n    command: bind-test\n    with:\n      target: "$INPUTS.target"\n',
      body: [
        'fixture:',
        '  resolved-text-contains:',
        '    node-a: "target=issue #3031"',
        'node-a: "stub"',
      ].join('\n'),
    });
    mkdirSync(join(cwd, '.archon', 'commands'), { recursive: true });
    writeFileSync(join(cwd, '.archon', 'commands', 'bind-test.md'), 'target=$INPUTS.target');
    const report = await runFixtures({
      workflows: [workflowsOnDisk(cwd, ['test-wf'])[0]],
      cwd,
    });

    expect(report.failed).toBe(1);
    expect(report.results[0].failureReason).toBe(
      'expected node \'node-a\' resolved text to contain "target=issue #3031"'
    );
  });

  it('reports a malformed fixture as a failure, not a crash', async () => {
    const { cwd } = writeTempProject({ body: ['fixture:', '  expect: bogus'].join('\n') });
    const report = await runFixtures({
      workflows: [workflowsOnDisk(cwd, ['test-wf'])[0]],
      cwd,
    });
    expect(report.failed).toBe(1);
    expect(report.results[0].failureReason).toContain('expect');
  });

  it('returns zero results and no failure when nothing is declared', async () => {
    const cwd = makeTempProject();
    const report = await runFixtures({ workflows: [], cwd });
    expect(report.results).toHaveLength(0);
    expect(report.passed).toBe(0);
    expect(report.failed).toBe(0);
  });

  it('throws for an explicit target that matches no fixtures', async () => {
    const { cwd } = writeTempProject({ body: passingBody });
    await expect(runFixtures({ workflows: [], cwd, target: 'no-such-pack' })).rejects.toThrow(
      'No fixtures found'
    );
  });

  it('suggests only workflows that carry fixtures when a target has none', async () => {
    const { cwd } = writeTempProject({ body: passingBody });
    const bareDir = join(cwd, '.archon', 'workflows', 'bare');
    mkdirSync(bareDir, { recursive: true });
    writeFileSync(
      join(bareDir, 'bare-wf.yaml'),
      'name: bare-wf\ndescription: test\nnodes:\n  - id: node-a\n    prompt: hi\n'
    );
    const err = await runFixtures({
      workflows: [
        ...workflowsOnDisk(cwd, ['test-wf']),
        ...workflowsOnDisk(cwd, ['bare-wf'], 'bare'),
      ],
      cwd,
      target: 'bare-wf',
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const suggested = /fixtures \(([^)]*)\)/.exec((err as Error).message)?.[1] ?? '';
    expect(suggested.split(', ')).toEqual(['test-wf']);
  });

  it('excludes fixture-targeted workflows the catalog cannot load from suggestions', async () => {
    const { cwd } = writeTempProject({ body: passingBody });
    // A name-only YAML passes workflowNamesBeside but fails parseWorkflow, so the fixture
    // beside it targets a workflow the command can never resolve (#2850).
    const brokenDir = join(cwd, '.archon', 'workflows', 'broken');
    mkdirSync(join(brokenDir, 'fixtures'), { recursive: true });
    writeFileSync(join(brokenDir, 'broken-wf.yaml'), 'name: broken-wf\n');
    writeFileSync(join(brokenDir, 'fixtures', 'orphan.stubs.yaml'), passingBody);
    const err = await runFixtures({
      workflows: workflowsOnDisk(cwd, ['test-wf']),
      cwd,
      target: 'nope',
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const suggested = /fixtures \(([^)]*)\)/.exec((err as Error).message)?.[1] ?? '';
    expect(suggested.split(', ')).toEqual(['test-wf']);
  });

  it('reports the divergence hint when discovered fixtures target no catalog workflow', async () => {
    const { cwd } = writeTempProject({ body: passingBody });
    const err = await runFixtures({
      workflows: [],
      cwd,
      target: 'nope',
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(
      /Discovered fixtures target no workflow in the discovery catalog/
    );
    expect((err as Error).message).not.toMatch(/declares fixtures/);
  });

  it('says no workflow declares fixtures when discovery found no fixtures at all', async () => {
    const cwd = makeTempProject();
    const packDir = join(cwd, '.archon', 'workflows', 'pack');
    mkdirSync(packDir, { recursive: true });
    writeFileSync(
      join(packDir, 'test-wf.yaml'),
      'name: test-wf\ndescription: test\nnodes:\n  - id: node-a\n    prompt: hello\n'
    );
    const err = await runFixtures({
      workflows: workflowsOnDisk(cwd, ['test-wf']),
      cwd,
      target: 'test-wf',
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/No workflow in any discovery scope declares fixtures/);
    expect((err as Error).message).not.toContain('()');
  });

  it('restricts to fixtures of the named workflow via target', async () => {
    const { cwd } = writeTempProject({
      workflowName: 'target-wf',
      fixtureName: 'only-target',
      body: passingBody,
    });
    const workflowsRoot = join(cwd, '.archon', 'workflows');
    const otherDir = join(workflowsRoot, 'other');
    mkdirSync(join(otherDir, 'fixtures'), { recursive: true });
    writeFileSync(
      join(otherDir, 'other-wf.yaml'),
      'name: other-wf\ndescription: test\nnodes:\n  - id: node-a\n    prompt: hi\n'
    );
    writeFileSync(
      join(otherDir, 'fixtures', 'other-fixture.stubs.yaml'),
      ['fixture:', '  expect: failed', '  fail-node: node-a', 'node-a: x'].join('\n')
    );
    const report = await runFixtures({
      workflows: [
        ...workflowsOnDisk(cwd, ['target-wf']),
        ...workflowsOnDisk(cwd, ['other-wf'], 'other'),
      ],
      cwd,
      target: 'target-wf',
    });
    expect(report.results.map(r => r.fixture)).toEqual([
      expect.stringContaining('only-target.stubs.yaml'),
    ]);
    expect(report.passed).toBe(1);
  });

  it('filters by pack name when the target is not a workflow name', async () => {
    const { cwd } = writeTempProject({ body: passingBody });
    const report = await runFixtures({
      workflows: workflowsOnDisk(cwd, ['test-wf']),
      cwd,
      target: 'pack',
    });
    expect(report.passed).toBe(1);
  });

  /** Pack layout like the bundled SDLC pack: `<pack>/<workflow-folder>/fixtures/`, plus a sibling pack whose name extends `sdlc` so the path-containment anchor cannot drift. */
  function writeNestedPackProject(): { cwd: string } {
    const cwd = makeTempProject();
    for (const folder of ['plan', 'ship']) {
      const workflowDir = join(cwd, '.archon', 'workflows', 'sdlc', folder);
      mkdirSync(join(workflowDir, 'fixtures'), { recursive: true });
      writeFileSync(
        join(workflowDir, `${folder}-wf.yaml`),
        `name: ${folder}-wf\ndescription: test\nnodes:\n  - id: node-a\n    prompt: hello\n`
      );
      writeFileSync(
        join(workflowDir, 'fixtures', `${folder}.stubs.yaml`),
        ['fixture:', '  expect: completed', 'node-a: "stub output"', ''].join('\n')
      );
    }
    const extDir = join(cwd, '.archon', 'workflows', 'sdlc-ext', 'ext');
    mkdirSync(join(extDir, 'fixtures'), { recursive: true });
    writeFileSync(
      join(extDir, 'ext-wf.yaml'),
      'name: ext-wf\ndescription: test\nnodes:\n  - id: node-a\n    prompt: hello\n'
    );
    writeFileSync(
      join(extDir, 'fixtures', 'ext.stubs.yaml'),
      ['fixture:', '  expect: completed', 'node-a: "stub output"', ''].join('\n')
    );
    return { cwd };
  }

  it('resolves a nested pack by name, workflow folder, and pack directory path', async () => {
    const { cwd } = writeNestedPackProject();
    const workflows = [
      ...workflowsOnDisk(cwd, ['plan-wf'], 'sdlc/plan'),
      ...workflowsOnDisk(cwd, ['ship-wf'], 'sdlc/ship'),
      ...workflowsOnDisk(cwd, ['ext-wf'], 'sdlc-ext/ext'),
    ];
    const fixtureLabels = (target: string | undefined) =>
      runFixtures({ workflows, cwd, ...(target !== undefined ? { target } : {}) }).then(report =>
        report.results.map(r => r.fixture)
      );

    const packPath = join(cwd, '.archon', 'workflows', 'sdlc');
    // Exact labels pin both the scope-root-relative shape and the boundary against the
    // prefix-named `sdlc-ext` sibling: the `dir + sep` containment anchor must never match it.
    await expect(fixtureLabels('sdlc')).resolves.toEqual([
      'sdlc/plan/fixtures/plan.stubs.yaml',
      'sdlc/ship/fixtures/ship.stubs.yaml',
    ]);
    await expect(fixtureLabels('ship')).resolves.toEqual(['sdlc/ship/fixtures/ship.stubs.yaml']);
    await expect(fixtureLabels('sdlc-ext')).resolves.toEqual([
      'sdlc-ext/ext/fixtures/ext.stubs.yaml',
    ]);
    await expect(fixtureLabels('.archon/workflows/sdlc')).resolves.toHaveLength(2);
    await expect(fixtureLabels(packPath)).resolves.toHaveLength(2);
    await expect(fixtureLabels(undefined)).resolves.toHaveLength(3);
  });

  it('resolves relative path targets from the invoking directory before the project root', async () => {
    const { cwd } = writeNestedPackProject();
    const invokingDir = join(cwd, 'tools');
    mkdirSync(invokingDir, { recursive: true });
    const workflows = [
      ...workflowsOnDisk(cwd, ['plan-wf'], 'sdlc/plan'),
      ...workflowsOnDisk(cwd, ['ship-wf'], 'sdlc/ship'),
      ...workflowsOnDisk(cwd, ['ext-wf'], 'sdlc-ext/ext'),
    ];

    await expect(
      runFixtures({
        workflows,
        cwd,
        targetCwd: invokingDir,
        target: '../.archon/workflows/sdlc/plan',
      }).then(report => report.results.map(result => result.fixture))
    ).resolves.toEqual(['sdlc/plan/fixtures/plan.stubs.yaml']);

    await expect(
      runFixtures({
        workflows,
        cwd,
        targetCwd: invokingDir,
        target: '.archon/workflows/sdlc',
      }).then(report => report.results.map(result => result.fixture))
    ).resolves.toEqual([
      'sdlc/plan/fixtures/plan.stubs.yaml',
      'sdlc/ship/fixtures/ship.stubs.yaml',
    ]);

    await expect(
      runFixtures({ workflows, cwd, targetCwd: invokingDir, target: 'sdlc' }).then(report =>
        report.results.map(result => result.fixture)
      )
    ).resolves.toEqual([
      'sdlc/plan/fixtures/plan.stubs.yaml',
      'sdlc/ship/fixtures/ship.stubs.yaml',
    ]);
  });

  it.skipIf(process.platform === 'win32')(
    'keeps a bare workflow name out of a same-named invoking-directory symlink',
    async () => {
      const { cwd } = writeNestedPackProject();
      const invokingDir = join(cwd, 'tools');
      mkdirSync(invokingDir, { recursive: true });
      symlinkSync(join(cwd, '.archon', 'workflows', 'sdlc'), join(invokingDir, 'plan-wf'), 'dir');
      const workflows = [
        ...workflowsOnDisk(cwd, ['plan-wf'], 'sdlc/plan'),
        ...workflowsOnDisk(cwd, ['ship-wf'], 'sdlc/ship'),
        ...workflowsOnDisk(cwd, ['ext-wf'], 'sdlc-ext/ext'),
      ];

      await expect(
        runFixtures({ workflows, cwd, targetCwd: invokingDir, target: 'plan-wf' }).then(report =>
          report.results.map(result => result.fixture)
        )
      ).resolves.toEqual(['sdlc/plan/fixtures/plan.stubs.yaml']);
    }
  );

  // Junctions would also resolve on Windows, but fs.realpath's junction handling is
  // platform-dependent; ubuntu CI already runs this, and that is where the tmpdir
  // realpath is the identity and the symlink spelling is the only protection.
  it.skipIf(process.platform === 'win32')(
    'resolves a target spelled through a symlink to the pack directory',
    async () => {
      const { cwd } = writeNestedPackProject();
      const linkPath = join(cwd, 'sdlc-link');
      symlinkSync(join(cwd, '.archon', 'workflows', 'sdlc'), linkPath, 'dir');
      const workflows = [
        ...workflowsOnDisk(cwd, ['plan-wf'], 'sdlc/plan'),
        ...workflowsOnDisk(cwd, ['ship-wf'], 'sdlc/ship'),
        ...workflowsOnDisk(cwd, ['ext-wf'], 'sdlc-ext/ext'),
      ];
      const report = await runFixtures({ workflows, cwd, target: linkPath });
      // Selection outcomes, not implementation details: drops both the containment
      // anchor and the discovery-side realpath, so a revert cannot pass silently.
      expect(report.results.map(r => r.fixture)).toEqual([
        'sdlc/plan/fixtures/plan.stubs.yaml',
        'sdlc/ship/fixtures/ship.stubs.yaml',
      ]);
    }
  );

  it('selects by the union of workflow name and folder: a target that is both picks both', async () => {
    const cwd = makeTempProject();
    // Workflow `ship` inside folder `plan`: its fixture matches by name only.
    const planDir = join(cwd, '.archon', 'workflows', 'sdlc', 'plan');
    mkdirSync(join(planDir, 'fixtures'), { recursive: true });
    writeFileSync(
      join(planDir, 'ship.yaml'),
      'name: ship\ndescription: test\nnodes:\n  - id: node-a\n    prompt: hello\n'
    );
    writeFileSync(
      join(planDir, 'fixtures', 'ship.stubs.yaml'),
      ['fixture:', '  expect: completed', 'node-a: "stub output"', ''].join('\n')
    );
    // Folder `ship` with a differently-named workflow: its fixture matches by folder only.
    const shipDir = join(cwd, '.archon', 'workflows', 'sdlc', 'ship');
    mkdirSync(join(shipDir, 'fixtures'), { recursive: true });
    writeFileSync(
      join(shipDir, 'ship-wf.yaml'),
      'name: ship-wf\ndescription: test\nnodes:\n  - id: node-a\n    prompt: hello\n'
    );
    writeFileSync(
      join(shipDir, 'fixtures', 'ship.stubs.yaml'),
      ['fixture:', '  expect: completed', 'node-a: "stub output"', ''].join('\n')
    );
    const report = await runFixtures({
      workflows: [
        ...workflowsOnDisk(cwd, ['ship'], 'sdlc/plan'),
        ...workflowsOnDisk(cwd, ['ship-wf'], 'sdlc/ship'),
      ],
      cwd,
      target: 'ship',
    });
    // Name-first precedence would drop the ship-folder fixture; dir-first would drop the plan one.
    expect(report.results.map(r => r.fixture).sort()).toEqual([
      'sdlc/plan/fixtures/ship.stubs.yaml',
      'sdlc/ship/fixtures/ship.stubs.yaml',
    ]);
  });

  it('rejects a target naming a workflow that is on disk but not in the catalog', async () => {
    const cwd = makeTempProject();
    // `broken-wf` parses far enough to declare a name but never reaches the catalog — the
    // shape of an unfinished or unloadable workflow file that still has fixtures beside it.
    const brokenDir = join(cwd, '.archon', 'workflows', 'broken');
    mkdirSync(join(brokenDir, 'fixtures'), { recursive: true });
    writeFileSync(
      join(brokenDir, 'broken-wf.yaml'),
      'name: broken-wf\ndescription: test\nnodes:\n  - id: node-a\n    prompt: hello\n'
    );
    writeFileSync(
      join(brokenDir, 'fixtures', 'orphan.stubs.yaml'),
      ['fixture:', '  expect: completed', 'node-a: "stub output"', ''].join('\n')
    );
    // A loaded workflow elsewhere, so the failure is "this target is unresolved" rather
    // than "nothing is loaded at all" — and so the hint names a real alternative.
    const okDir = join(cwd, '.archon', 'workflows', 'ok');
    mkdirSync(join(okDir, 'fixtures'), { recursive: true });
    writeFileSync(
      join(okDir, 'ok-wf.yaml'),
      'name: ok-wf\ndescription: test\nnodes:\n  - id: node-a\n    prompt: hello\n'
    );
    writeFileSync(
      join(okDir, 'fixtures', 'ok.stubs.yaml'),
      ['fixture:', '  expect: completed', 'node-a: "stub output"', ''].join('\n')
    );

    // Ungated name matching selects the orphan fixture and reports it as a per-fixture
    // "no discovered workflow matches" failure, which blames the fixture for a target problem.
    await expect(
      runFixtures({ workflows: workflowsOnDisk(cwd, ['ok-wf'], 'ok'), cwd, target: 'broken-wf' })
    ).rejects.toThrow("No fixtures found for 'broken-wf'. Name a workflow with fixtures (ok-wf)");

    // The gate must not cost the loaded name its own resolution.
    const loaded = await runFixtures({
      workflows: workflowsOnDisk(cwd, ['ok-wf'], 'ok'),
      cwd,
      target: 'ok-wf',
    });
    expect(loaded.results.map(r => r.fixture)).toEqual(['ok/fixtures/ok.stubs.yaml']);
  });

  it('lets a project fixture shadow the bundled fixture it overrides', async () => {
    const cwd = makeTempProject();
    const bundled = makeTempProject();
    // The same relative fixture in two scopes: a project that copied a bundled workflow
    // folder to customize it. Both declare the same workflow name, so both would be checked
    // against the same catalog entry and print the same label — indistinguishable in output.
    const write = (root: string, expectOutcome: string) => {
      const dir = join(root, 'ship');
      mkdirSync(join(dir, 'fixtures'), { recursive: true });
      writeFileSync(
        join(dir, 'ship-wf.yaml'),
        'name: ship-wf\ndescription: test\nnodes:\n  - id: node-a\n    prompt: hello\n'
      );
      writeFileSync(
        join(dir, 'fixtures', 'x.stubs.yaml'),
        ['fixture:', `  expect: ${expectOutcome}`, 'node-a: "stub output"', ''].join('\n')
      );
    };
    write(join(cwd, '.archon', 'workflows'), 'completed');
    write(bundled, 'failed');

    const report = await runFixtures({
      workflows: workflowsOnDisk(cwd, ['ship-wf'], 'ship'),
      cwd,
      sourceRoots: {
        ...liveSourceRoots(cwd),
        globalWorkflows: join(cwd, '.empty', 'global-workflows'),
        bundledWorkflows: bundled,
      },
    });

    // One result, and it is the project's: a path-keyed `seen` never dedups across scopes
    // (absolute paths are scope-unique) and yields two, while dedup that kept the wrong
    // side would report the bundled `expect: failed` under an identical label.
    expect(report.results.map(r => r.fixture)).toEqual(['ship/fixtures/x.stubs.yaml']);
    expect(report.results[0].expect).toBe('completed');
  });
});

describe('runFixtures exec-code isolation (#2851)', () => {
  const COMMITTED_YAML = 'committed-file\n';

  /**
   * The probe body {@link GUARD_YAML} runs.
   *
   * Captured and tested separately, not as `[ -z "$(git status --porcelain)" ]`: a git
   * that FAILS also prints nothing, so the inline form reads its silence as a clean tree
   * and the guard passes without having observed anything.
   *
   * Shared with the test that proves that, rather than restated there — a second copy
   * would keep passing after this one was reverted, which is the whole failure mode.
   */
  const GUARD_PROBE = ['status="$(git status --porcelain)" || exit 1', '[ -z "$status" ]'];

  /** A bash node whose success depends ONLY on the cleanliness of the checkout it executes in. */
  const GUARD_YAML = [
    'name: test-wf',
    'description: probe the checkout it executes in',
    'nodes:',
    '  - id: probe',
    '    bash: |',
    ...GUARD_PROBE.map(line => `      ${line}`),
  ].join('\n');

  const WRITER_YAML = [
    'name: writer-wf',
    'description: writes a relative-path file where it executes',
    'nodes:',
    '  - id: writer',
    '    bash: echo executed > leak.txt',
  ].join('\n');

  const execFixtureBody = ['fixture:', '  expect: completed', '', 'exec-code: true'].join('\n');

  const git = (cwd: string, ...args: string[]): Promise<unknown> =>
    execFileAsync('git', args, { cwd });

  /**
   * Turn a plain temp project into a git repo, committing everything already in it plus
   * one file of its own.
   *
   * Three git processes, not five: the identity travels as `-c` overrides on the commit
   * itself rather than as two separate `git config` writes. Only the prepared repos below
   * and the one test whose premise is what HEAD holds pay this; process creation is the
   * expensive part on Windows CI (#2882).
   */
  async function initGitWithCommittedFile(cwd: string): Promise<void> {
    await git(cwd, 'init', '-q');
    writeFileSync(join(cwd, 'tracked.txt'), COMMITTED_YAML);
    await git(cwd, 'add', '-A');
    await git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  }

  /**
   * Caller checkouts prepared once for the block and copied per test (#2882).
   *
   * `git worktree add` has nothing to check out without a HEAD commit, so every exec-code
   * test needs its caller to be a real repository. Built in place that is three git
   * processes per test, and process creation is what this block costs on a contended
   * Windows runner — the parity test below spent 5015ms of a 5000ms budget there. A plain
   * repository's metadata holds no absolute paths, so copying a prepared one is an
   * independent repository at file-copy price: ~0.8ms measured locally against ~50ms for
   * the three processes.
   *
   * Two shapes, because what HEAD holds is part of some tests' premise. `trackedOnlyRepo`
   * commits `tracked.txt` alone, for tests whose own project files may sit untracked
   * beside it. `guardRepo` commits the guard workflow and its fixture as well, so a caller
   * copied from it is genuinely clean — the state the parity test contrasts dirt against.
   */
  let trackedOnlyRepo: string;
  let guardRepo: string;

  beforeAll(async () => {
    trackedOnlyRepo = mkdtempSync(join(tmpdir(), 'fixture-runner-repo-'));
    await initGitWithCommittedFile(trackedOnlyRepo);
    guardRepo = mkdtempSync(join(tmpdir(), 'fixture-runner-repo-'));
    writeTempProject({ cwd: guardRepo, workflowYaml: GUARD_YAML, body: execFixtureBody });
    await initGitWithCommittedFile(guardRepo);
  });

  // Outlives the per-test roots `trackTempRoots` tears down, so it needs its own hook.
  afterAll(async () => {
    for (const repo of [trackedOnlyRepo, guardRepo]) await removeTempTree(repo);
  });

  /** A caller checkout copied from a prepared repo — a HEAD commit with no git process. */
  function callerFrom(template: string, cwd = makeTempProject()): string {
    cpSync(template, cwd, { recursive: true });
    return cwd;
  }

  it('gives clean and pre-dirtied callers the same verdict (#2851)', async () => {
    // One caller, invoked twice: the dirt is then the ONLY difference between the two
    // verdicts. Two separately built repos would also differ in identity and history.
    const cwd = callerFrom(guardRepo);
    const workflows = [workflowsOnDisk(cwd, ['test-wf'])[0]];

    const cleanReport = await runFixtures({ workflows, cwd });
    expect(cleanReport.failed).toBe(0);

    // Exactly the operator-tree state the issue reports: one modified tracked file,
    // one untracked stray.
    writeFileSync(join(cwd, 'tracked.txt'), `${COMMITTED_YAML}edited\n`);
    writeFileSync(join(cwd, 'scratch.txt'), 'untracked stray\n');
    const dirtyReport = await runFixtures({ workflows, cwd });
    expect(dirtyReport.passed).toBe(1);
  });

  it('fails the guard when git cannot report status, rather than passing on its silence', async () => {
    // What the test above rests on: the guard must distinguish "the tree is clean" from
    // "I never got to look". A failing `git status` prints nothing, so the shorter
    // `[ -z "$(git status --porcelain)" ]` reads that silence as cleanliness — measured,
    // not supposed: with the scratch worktree replaced by a plain empty directory, the
    // inline form passed BOTH halves above, certifying a checkout that never happened.
    //
    // `GIT_DIR` pointing nowhere reproduces exactly that condition — git exits non-zero
    // having written nothing to stdout — and needs no repository, no scratch worktree and
    // no process beyond the one the guard itself runs in.
    const cwd = makeTempProject();
    const exit = await execFileAsync(resolveBashPath(), ['-c', GUARD_PROBE.join('\n')], {
      cwd,
      env: { ...process.env, GIT_DIR: join(cwd, 'no-such-git-dir') },
    }).then(
      () => 'the guard passed',
      (error: { code?: unknown }) => error.code
    );
    // Bash's exit status, so specifically the guard's own `|| exit 1`. A string here would
    // be a spawn failure — bash never ran — which must not read as the guard working.
    expect(exit).toBe(1);
  });

  it('keeps executed writes out of the caller checkout (#2851)', async () => {
    const { cwd } = writeTempProject({
      workflowName: 'writer-wf',
      workflowYaml: WRITER_YAML,
      body: execFixtureBody,
    });
    callerFrom(trackedOnlyRepo, cwd);
    const report = await runFixtures({
      workflows: [workflowsOnDisk(cwd, ['writer-wf'])[0]],
      cwd,
    });
    // The node genuinely executed (passing would fail if it had errored); its write
    // landed somewhere that is not the caller's working tree.
    expect(report.results[0].outcome).toBe('completed');
    expect(existsSync(join(cwd, 'leak.txt'))).toBe(false);
    expect(readFileSync(join(cwd, 'tracked.txt'), 'utf8')).toBe(COMMITTED_YAML);
  });

  it('keeps PWD and OLDPWD-based inline code writes in the scratch worktree (#2890)', async () => {
    const writerYaml = [
      'name: pwd-writer-wf',
      'description: writes through the working-directory environment',
      'nodes:',
      '  - id: writer',
      '    script: |',
      "      for (const dir of [process.env.PWD, process.env.OLDPWD]) await Bun.write(`${dir}/leak.txt`, 'executed');",
      '    runtime: bun',
    ].join('\n');
    const { cwd } = writeTempProject({
      workflowName: 'pwd-writer-wf',
      workflowYaml: writerYaml,
      body: execFixtureBody,
    });
    callerFrom(trackedOnlyRepo, cwd);
    const previousPwd = process.env.PWD;
    const previousOldPwd = process.env.OLDPWD;
    process.env.PWD = cwd;
    process.env.OLDPWD = cwd;
    try {
      const report = await runFixtures({
        workflows: [workflowsOnDisk(cwd, ['pwd-writer-wf'])[0]],
        cwd,
      });
      expect(report.results[0].outcome).toBe('completed');
      expect(existsSync(join(cwd, 'leak.txt'))).toBe(false);
    } finally {
      if (previousPwd === undefined) delete process.env.PWD;
      else process.env.PWD = previousPwd;
      if (previousOldPwd === undefined) delete process.env.OLDPWD;
      else process.env.OLDPWD = previousOldPwd;
    }
  });

  const SCRIPT_YAML = [
    'name: script-wf',
    'description: runs a named script',
    'nodes:',
    '  - id: run-script',
    '    script: greet-script',
    '    runtime: bun',
  ].join('\n');

  function writeScript(cwd: string, body: string): void {
    mkdirSync(join(cwd, '.archon', 'scripts'), { recursive: true });
    writeFileSync(join(cwd, '.archon', 'scripts', 'greet-script.ts'), body);
  }

  it('executes the captured copy of a named script, not the caller tree file (#2851)', async () => {
    const { cwd } = writeTempProject({
      workflowName: 'script-wf',
      workflowYaml: SCRIPT_YAML,
      body: execFixtureBody,
    });
    // Absolute, so the probe records where the script FILE was, independently of the
    // directory it executed in.
    const probe = join(cwd, 'ran-from.txt');
    writeScript(
      cwd,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(probe)}, import.meta.path);\n`
    );
    callerFrom(trackedOnlyRepo, cwd);

    const report = await runFixtures({
      workflows: [workflowsOnDisk(cwd, ['script-wf'])[0]],
      cwd,
    });
    expect(report.failed).toBe(0);

    // The bytes that ran came from the invocation's source capture, under its project
    // scope — so every `__file__`-relative read and write a script performs lands in the
    // capture too, not in the operator's checkout.
    const ranFrom = readFileSync(probe, 'utf8');
    expect(ranFrom).toContain('fixture-source-');
    expect(ranFrom.endsWith(join('project', '.archon', 'scripts', 'greet-script.ts'))).toBe(true);
  });

  it('shares one capture across every fixture in an invocation (#2851)', async () => {
    const { cwd } = writeTempProject({
      workflowName: 'script-wf',
      workflowYaml: SCRIPT_YAML,
      fixtureName: 'first',
      body: execFixtureBody,
    });
    // A second fixture beside the first, targeting the same workflow: two fixtures, one
    // `runFixtures` call. Capturing per fixture would still pass every other test here.
    writeFileSync(
      join(cwd, '.archon', 'workflows', 'pack', 'fixtures', 'second.stubs.yaml'),
      execFixtureBody
    );
    const probe = join(cwd, 'ran-from.txt');
    writeScript(
      cwd,
      `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(probe)}, import.meta.path + '\\n');\n`
    );
    callerFrom(trackedOnlyRepo, cwd);

    const report = await runFixtures({
      workflows: [workflowsOnDisk(cwd, ['script-wf'])[0]],
      cwd,
    });
    expect(report.passed).toBe(2);

    // Both executions resolved out of the SAME capture directory — the snapshot the whole
    // invocation is a function of. Two capture ids here would mean an edit landing between
    // fixtures could change the second verdict.
    const captureIds = readFileSync(probe, 'utf8')
      .split('\n')
      .filter(line => line.length > 0)
      .map(line => /fixture-source-[0-9a-f-]+/.exec(line)?.[0]);
    expect(captureIds).toHaveLength(2);
    expect(captureIds[0]).toBeDefined();
    expect(captureIds[1]).toBe(captureIds[0]);
  });

  it('captures the working tree, so an uncommitted script edit is what runs (#2851)', async () => {
    const { cwd } = writeTempProject({
      workflowName: 'script-wf',
      workflowYaml: SCRIPT_YAML,
      body: execFixtureBody,
    });
    // Committed — and therefore the only version a scratch worktree of HEAD holds. This
    // test builds its repo in place rather than copying a prepared one precisely because
    // what HEAD holds is its premise.
    writeScript(cwd, 'process.exit(1);\n');
    await initGitWithCommittedFile(cwd);
    // Uncommitted: the edit an author is iterating on when they run `workflow test`.
    writeScript(cwd, 'console.log("ok");\n');

    const report = await runFixtures({
      workflows: [workflowsOnDisk(cwd, ['script-wf'])[0]],
      cwd,
    });
    expect(report.results[0].outcome).toBe('completed');
  });

  it('captures the command folder the source config names (#2851)', async () => {
    const body = ['fixture:', '  expect: completed', '', 'run-command: "stub"'].join('\n');
    const workflowYaml = [
      'name: command-wf',
      'description: sources its prompt from a command file',
      'nodes:',
      '  - id: run-command',
      '    command: greet',
    ].join('\n');
    const { cwd } = writeTempProject({
      workflowName: 'command-wf',
      workflowYaml,
      body,
    });
    // A repo that moved its commands off the default folder; only the source config
    // says where they are, and the capture is what a command node then reads.
    mkdirSync(join(cwd, '.archon', 'prompts'), { recursive: true });
    writeFileSync(join(cwd, '.archon', 'prompts', 'greet.md'), 'Greet $ARGUMENTS');
    const workflows = [workflowsOnDisk(cwd, ['command-wf'])[0]];

    const configured = await runFixtures({
      workflows,
      cwd,
      sourceConfig: {
        load_default_workflows: true,
        load_default_commands: true,
        command_folder: '.archon/prompts',
      },
    });
    expect(configured.failed).toBe(0);

    // Under the standard folders that same directory is outside every captured scope, and
    // the node fails the way a real run would rather than quietly reading the live file.
    const standardFolders = await runFixtures({
      workflows,
      cwd,
      sourceConfig: DEFAULT_WORKFLOW_SOURCE_CONFIG,
    });
    expect(standardFolders.failed).toBe(1);
  });

  it('disposes both the scratch worktree and the source capture (#2851)', async () => {
    const cwd = callerFrom(guardRepo);
    const home = makeTempProject('fixture-runner-home-');
    const previousHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = home;
    try {
      const report = await runFixtures({
        workflows: [workflowsOnDisk(cwd, ['test-wf'])[0]],
        cwd,
      });
      expect(report.failed).toBe(0);
    } finally {
      if (previousHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = previousHome;
    }
    // `git worktree add` records metadata in the caller's .git, so a leaked
    // workspace would show up here as a stale entry.
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd });
    expect(stdout).not.toContain('fixture-exec-');
    expect(stdout.split('\n').filter(line => line.startsWith('worktree '))).toHaveLength(1);
    // A leaked capture is heavier than a leaked scratch worktree — it is a full copy of the
    // project, global, and bundled source trees — and Archon's own SDLC workflows run
    // `workflow test` repeatedly, so it would compound.
    const leftBehind = readdirSync(join(home, 'temp')).filter(
      entry => entry.startsWith('fixture-exec-') || entry.startsWith('fixture-source-')
    );
    expect(leftBehind).toEqual([]);
  });

  it('fails an exec-code fixture in a directory outside any git repository', async () => {
    const { cwd } = writeTempProject({
      workflowName: 'writer-wf',
      workflowYaml: WRITER_YAML,
      body: execFixtureBody,
    });
    const report = await runFixtures({
      workflows: [workflowsOnDisk(cwd, ['writer-wf'])[0]],
      cwd,
    });
    expect(report.failed).toBe(1);
    expect(report.results[0].failureReason).toContain('not inside a git repository');
  });
});
