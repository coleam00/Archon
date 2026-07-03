import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMarketplaceBundle, slugify, BundleError } from './bundle';
import type { WorkflowDefinition } from '@archon/workflows/schemas/workflow';
import type { DagNode } from '@archon/workflows/schemas/dag-node';

function workflow(name: string, nodes: DagNode[]): WorkflowDefinition {
  return { name, description: 'test workflow', nodes } as WorkflowDefinition;
}

describe('slugify', () => {
  test('lowercases and hyphenates', () => {
    expect(slugify('My Cool Workflow')).toBe('my-cool-workflow');
  });

  test('collapses runs of non-alphanumerics (but not existing hyphens) into a single hyphen', () => {
    // Matches the spec regex exactly: /[^a-z0-9-]+/g — hyphens are in the
    // allowed set, so a pre-existing run of hyphens passes through untouched.
    expect(slugify('a___b---c')).toBe('a-b---c');
  });

  test('trims leading/trailing hyphens', () => {
    expect(slugify('  Weird!! Name??  ')).toBe('weird-name');
  });

  test('a name of only symbols slugifies to an empty string', () => {
    expect(slugify('!!!')).toBe('');
  });
});

describe('buildMarketplaceBundle', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'archon-bundle-test-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  test('bundles the main YAML with no referenced files', async () => {
    const wf = workflow('Simple Flow', [{ id: 'n1', prompt: 'do the thing' } as DagNode]);
    const files = await buildMarketplaceBundle({
      cwd,
      workflowName: 'Simple Flow',
      yamlContent: 'name: Simple Flow\n',
      workflow: wf,
    });
    expect(files).toEqual([
      {
        repoPath: '.archon/marketplace/simple-flow/simple-flow.yaml',
        content: 'name: Simple Flow\n',
      },
    ]);
  });

  test('bundles a referenced command file', async () => {
    await mkdir(join(cwd, '.archon', 'commands'), { recursive: true });
    await writeFile(join(cwd, '.archon', 'commands', 'helper.md'), '# Helper\n');

    const wf = workflow('With Command', [{ id: 'n1', command: 'helper' } as DagNode]);
    const files = await buildMarketplaceBundle({
      cwd,
      workflowName: 'With Command',
      yamlContent: 'name: With Command\n',
      workflow: wf,
    });
    expect(files).toContainEqual({
      repoPath: '.archon/marketplace/with-command/commands/helper.md',
      content: '# Helper\n',
    });
    expect(files).toHaveLength(2);
  });

  test('bundles a referenced named script (.ts)', async () => {
    await mkdir(join(cwd, '.archon', 'scripts'), { recursive: true });
    await writeFile(join(cwd, '.archon', 'scripts', 'analyze.ts'), 'console.log(1);\n');

    const wf = workflow('With Script', [
      { id: 'n1', script: 'analyze', runtime: 'bun' } as DagNode,
    ]);
    const files = await buildMarketplaceBundle({
      cwd,
      workflowName: 'With Script',
      yamlContent: 'name: With Script\n',
      workflow: wf,
    });
    expect(files).toContainEqual({
      repoPath: '.archon/marketplace/with-script/scripts/analyze.ts',
      content: 'console.log(1);\n',
    });
  });

  test('excludes inline script bodies from bundling', async () => {
    const wf = workflow('Inline Script', [
      { id: 'n1', script: 'console.log("inline");', runtime: 'bun' } as DagNode,
    ]);
    const files = await buildMarketplaceBundle({
      cwd,
      workflowName: 'Inline Script',
      yamlContent: 'name: Inline Script\n',
      workflow: wf,
    });
    expect(files).toHaveLength(1);
  });

  test('excludes multi-line inline script bodies', async () => {
    const wf = workflow('Inline Multi', [
      { id: 'n1', script: 'const x = 1;\nconsole.log(x);', runtime: 'bun' } as DagNode,
    ]);
    const files = await buildMarketplaceBundle({
      cwd,
      workflowName: 'Inline Multi',
      yamlContent: 'name: Inline Multi\n',
      workflow: wf,
    });
    expect(files).toHaveLength(1);
  });

  test('dedupes a command referenced by multiple nodes', async () => {
    await mkdir(join(cwd, '.archon', 'commands'), { recursive: true });
    await writeFile(join(cwd, '.archon', 'commands', 'shared.md'), 'shared\n');

    const wf = workflow('Dedup', [
      { id: 'n1', command: 'shared' } as DagNode,
      { id: 'n2', command: 'shared' } as DagNode,
    ]);
    const files = await buildMarketplaceBundle({
      cwd,
      workflowName: 'Dedup',
      yamlContent: 'name: Dedup\n',
      workflow: wf,
    });
    expect(files).toHaveLength(2); // main yaml + one command file
  });

  test('throws missing-command-file for an unresolvable command reference', async () => {
    const wf = workflow('Missing Command', [{ id: 'n1', command: 'nope' } as DagNode]);
    await expect(
      buildMarketplaceBundle({
        cwd,
        workflowName: 'Missing Command',
        yamlContent: 'name: Missing Command\n',
        workflow: wf,
      })
    ).rejects.toThrow(BundleError);
  });

  test('throws missing-script-file for an unresolvable named script reference', async () => {
    const wf = workflow('Missing Script', [
      { id: 'n1', script: 'nope', runtime: 'bun' } as DagNode,
    ]);
    let caught: unknown;
    try {
      await buildMarketplaceBundle({
        cwd,
        workflowName: 'Missing Script',
        yamlContent: 'name: Missing Script\n',
        workflow: wf,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BundleError);
    expect((caught as BundleError).reason).toBe('missing-script-file');
  });

  test('throws invalid-slug when the workflow name has no alphanumerics', async () => {
    const wf = workflow('!!!', [{ id: 'n1', prompt: 'x' } as DagNode]);
    let caught: unknown;
    try {
      await buildMarketplaceBundle({ cwd, workflowName: '!!!', yamlContent: '', workflow: wf });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BundleError);
    expect((caught as BundleError).reason).toBe('invalid-slug');
  });

  test('rejects a path-traversal command reference', async () => {
    const wf = workflow('Traversal', [{ id: 'n1', command: '../../etc/passwd' } as DagNode]);
    let caught: unknown;
    try {
      await buildMarketplaceBundle({
        cwd,
        workflowName: 'Traversal',
        yamlContent: 'name: Traversal\n',
        workflow: wf,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BundleError);
    expect((caught as BundleError).reason).toBe('unsafe-reference');
  });

  test('rejects an absolute-path script reference', async () => {
    const wf = workflow('AbsScript', [
      { id: 'n1', script: '/etc/passwd', runtime: 'bun' } as DagNode,
    ]);
    let caught: unknown;
    try {
      await buildMarketplaceBundle({
        cwd,
        workflowName: 'AbsScript',
        yamlContent: 'name: AbsScript\n',
        workflow: wf,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BundleError);
    expect((caught as BundleError).reason).toBe('unsafe-reference');
  });
});
