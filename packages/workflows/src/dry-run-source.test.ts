// @archon-test-isolated
import { describe, expect, spyOn, test } from 'bun:test';
import * as archonPaths from '@archon/paths';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTestWorkflow } from './test-utils';
import { captureWorkflowSource, capturedSourceRoots, loadWorkflowSource } from './workflow-source';
import { readBundleIndex } from './defaults/bundle-inventory';
import { dryRunWorkflow, useDryRunFiles } from './dry-run-test-utils';

const { temporaryDirectory, commandFiles } = useDryRunFiles();

// These fixtures read only project files. Avoid copying the repository's bundled
// defaults into every capture; the materialization suite covers bundled content.
async function captureProjectSource(options: Parameters<typeof captureWorkflowSource>[0]) {
  const bundled = join(options.sourceRoot, 'empty-bundled');
  for (const pack of await readBundleIndex()) {
    mkdirSync(join(bundled, pack), { recursive: true });
  }
  const workflows = spyOn(archonPaths, 'getBundledWorkflowsPath').mockReturnValue(bundled);
  try {
    return await captureWorkflowSource(options);
  } finally {
    workflows.mockRestore();
  }
}

describe('dry-run source integrity', () => {
  test('refuses a changed caller-supplied capture at the node that reads it', async () => {
    const cwd = commandFiles({
      inspect: 'original',
    });
    const capture = await captureProjectSource({
      sourceRoot: cwd,
      captureRoot: join(cwd, 'capture'),
    });
    writeFileSync(
      join(capture.anchor.root, 'project', '.archon', 'commands', 'inspect.md'),
      'changed'
    );

    const result = await dryRunWorkflow({
      workflow: makeTestWorkflow({
        name: 'captured-dry-run',
        nodes: [{ id: 'inspect', command: 'inspect' }],
      }),
      cwd,
      sourceRoots: capturedSourceRoots(capture.anchor),
      stubs: { inspect: 'stubbed' },
    });

    expect(result.outcome).toBe('failed');
    expect(result.trace.find(entry => entry.nodeId === 'inspect')).toMatchObject({
      state: 'failed',
      reason: expect.stringContaining('captured source has changed'),
    });
  });

  test('an inline-only simulation is not invalidated by an unrelated capture change', async () => {
    const cwd = commandFiles({
      unused: 'original',
    });
    const capture = await captureProjectSource({
      sourceRoot: cwd,
      captureRoot: join(cwd, 'capture'),
    });
    writeFileSync(
      join(capture.anchor.root, 'project', '.archon', 'commands', 'unused.md'),
      'changed'
    );

    const result = await dryRunWorkflow({
      workflow: makeTestWorkflow({
        name: 'inline-dry-run',
        nodes: [{ id: 'think', prompt: 'inline body' }],
      }),
      cwd,
      sourceRoots: capturedSourceRoots(capture.anchor),
      stubs: { think: 'stubbed' },
    });

    expect(result.outcome).toBe('completed');
  });

  test('Python shared imports leave the frozen source unchanged in executable fixtures', async () => {
    const cwd = temporaryDirectory();
    const pack = join(cwd, '.archon', 'workflows', 'test-pack');
    mkdirSync(join(pack, '.shared'), { recursive: true });
    mkdirSync(join(pack, 'flow', 'scripts'), { recursive: true });
    writeFileSync(join(pack, '.shared', 'value.py'), 'value = "shared-ok"\n');
    writeFileSync(
      join(pack, 'flow', 'scripts', 'read.py'),
      [
        'from pathlib import Path',
        'import sys',
        'sys.path.insert(0, str(Path(__file__).resolve().parents[2] / ".shared"))',
        'from value import value',
        'sys.stdout.write(value)',
      ].join('\n')
    );
    const capture = await captureProjectSource({
      sourceRoot: cwd,
      captureRoot: join(cwd, 'capture'),
    });
    const script = '__archon_pack__project:test-pack:flow::read';
    const result = await dryRunWorkflow({
      workflow: makeTestWorkflow({
        name: 'shared-import',
        nodes: [{ id: 'read', script, runtime: 'uv' }],
      }),
      cwd,
      sourceRoots: capturedSourceRoots(capture.anchor),
      execCode: true,
    });
    expect(result.outcome).toBe('completed');
    expect(result.trace.find(entry => entry.nodeId === 'read')?.output).toBe('shared-ok');
    await expect(
      loadWorkflowSource(capture.anchor.root, capture.manifest.digest)
    ).resolves.toBeDefined();
  });

  test('rechecks a named script after an earlier node changes the capture', async () => {
    const cwd = temporaryDirectory();
    const scriptDir = join(cwd, '.archon', 'scripts');
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(join(scriptDir, 'inspect.ts'), 'console.log("original")');
    const capture = await captureProjectSource({
      sourceRoot: cwd,
      captureRoot: join(cwd, 'capture'),
    });
    const capturedScript = join(capture.anchor.root, 'project', '.archon', 'scripts', 'inspect.ts');
    const marker = join(cwd, 'changed-script-ran');
    const workflow = makeTestWorkflow({
      name: 'captured-script-dry-run',
      nodes: [
        {
          id: 'mutate',
          bash: `printf %s 'await Bun.write("${marker}", "ran")' > "${capturedScript}"`,
        },
        { id: 'inspect', script: 'inspect', runtime: 'bun', depends_on: ['mutate'] },
      ],
    });

    const result = await dryRunWorkflow({
      workflow,
      cwd,
      sourceRoots: capturedSourceRoots(capture.anchor),
      execCode: true,
    });

    expect(result.outcome).toBe('failed');
    expect(result.trace.find(entry => entry.nodeId === 'inspect')).toMatchObject({
      state: 'failed',
      reason: expect.stringContaining('captured source has changed'),
    });
    expect(existsSync(marker)).toBe(false);
  });

  test.each(['agent', 'loop'] as const)(
    'rechecks a command-backed %s node after an earlier node changes the capture',
    async kind => {
      const cwd = temporaryDirectory();
      const commandDir = join(cwd, '.archon', 'commands');
      mkdirSync(commandDir, { recursive: true });
      writeFileSync(join(commandDir, 'inspect.md'), 'original');
      const capture = await captureProjectSource({
        sourceRoot: cwd,
        captureRoot: join(cwd, 'capture'),
      });
      const capturedCommand = join(
        capture.anchor.root,
        'project',
        '.archon',
        'commands',
        'inspect.md'
      );
      const inspectedNode =
        kind === 'agent'
          ? { id: 'inspect', command: 'inspect', depends_on: ['mutate'] }
          : {
              id: 'inspect',
              loop: { command: 'inspect', until: 'DONE', max_iterations: 1 },
              depends_on: ['mutate'],
            };
      const workflow = makeTestWorkflow({
        name: `captured-${kind}-command-dry-run`,
        nodes: [{ id: 'mutate', bash: `printf changed > "${capturedCommand}"` }, inspectedNode],
      });

      const result = await dryRunWorkflow({
        workflow,
        cwd,
        sourceRoots: capturedSourceRoots(capture.anchor),
        stubs: { inspect: 'DONE' },
        execCode: true,
      });

      expect(result.outcome).toBe('failed');
      expect(result.trace.find(entry => entry.nodeId === 'inspect')).toMatchObject({
        state: 'failed',
        reason: expect.stringContaining('captured source has changed'),
      });
    }
  );
});
