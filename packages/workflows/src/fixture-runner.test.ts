/** Tests for the declared-data dry-run fixture runner (#2772). */
import { describe, it, expect, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkflow } from './loader';
import { expandWorkflowIncludes } from './include-expander';
import type { WorkflowWithSource } from './schemas/workflow';

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
import { formatFixtureReport, parseFixtureFile, runFixtures } from './fixture-runner';

function makeTempProject(): string {
  return mkdtempSync(join(tmpdir(), 'fixture-runner-'));
}

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface TempFixtureOptions {
  workflowName?: string;
  fixtureName?: string;
  body: string;
  /** Workflow yaml written next to fixtures/ — defaults to a one-node stub target. */
  workflowYaml?: string;
}

function writeTempProject(options: TempFixtureOptions): { cwd: string; fixturePath: string } {
  const cwd = makeTempProject();
  cleanups.push(cwd);
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

  it('rejects invalid stub values with the dry-run stub grammar', () => {
    expect(() => parseFixtureFile('node-a:\n  - bad\n', 'x')).toThrow('node-a');
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
    cleanups.push(cwd);
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
});
