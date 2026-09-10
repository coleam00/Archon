/**
 * Source capture: what a run freezes, and what it must keep resolving after the
 * authoring checkout moves on.
 */
import { describe, test, expect, afterAll, mock } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir, symlink, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

// Capture-cost control, same lever and same reason as `subrun.test.ts` (#2882):
// every `captureWorkflowSource` call here copies and digests the repo's OWN bundled
// scope — `.archon/workflows` plus `.archon/commands`, ~178 files — on top of the
// handful of fixture files the test wrote. Twenty-five captures in this file is ~4,400
// incidental file copies, and that bulk IO is what puts this suite at Bun's 5000ms
// budget on a contended Windows runner. No test here reads bundled CONTENT: the
// assertions count the PROJECT scope (`countScopeFiles`) and resolve fixture-written
// commands. Pointing the two bundle getters at an owned EMPTY tree keeps the bundled
// scope's semantics intact — an existing directory is still scanned, still copied,
// still recorded in the manifest — while removing the file fan-out.
// NB: point these one level DEEP (`<root>/defaults`) — captureWorkflowSource copies
// dirname(getDefault*Path()), so the getter's PARENT must be the owned empty tree.
const bundledDefaultsRoot = join(tmpdir(), `workflow-source-test-empty-bundled-${process.pid}`);
await mkdir(join(bundledDefaultsRoot, 'defaults'), { recursive: true });
afterAll(async () => {
  await rm(bundledDefaultsRoot, { recursive: true, force: true }).catch(() => {});
});
const realArchonPaths = await import('@archon/paths');
mock.module('@archon/paths', () => ({
  ...realArchonPaths,
  getDefaultWorkflowsPath: () => join(bundledDefaultsRoot, 'defaults'),
  getDefaultCommandsPath: () => join(bundledDefaultsRoot, 'defaults'),
}));

import {
  captureWorkflowSource,
  capturedSourceRoots,
  assertWorkflowSourceIntegrity,
  loadWorkflowSource,
  recordSelectedWorkflow,
  resolveChildDiscoveryRoot,
  resolveRunSourceCapture,
  WorkflowSourceIntegrityError,
  DEFAULT_WORKFLOW_SOURCE_CONFIG,
} from './workflow-source';
import {
  WORKFLOW_SOURCE_METADATA_KEY,
  readWorkflowSourceState,
  type WorkflowSourceConfig,
} from './schemas/workflow-run';
import { discoverScriptsForCwd } from './script-discovery';
import { loadCommandPrompt } from './executor-shared';
import { withCapturedSource } from './executor';
import { discoverWorkflows } from './workflow-discovery';
import type { WorkflowDeps } from './deps';
import { trackTempRoots } from '@archon/paths/test-utils';

/** One test's paths. Created by the test, never shared with another. */
interface Sandbox {
  readonly root: string;
  readonly source: string;
  readonly target: string;
  readonly runArtifacts: string;
}

const trackTempRoot = trackTempRoots();

/**
 * A temp root owned by one test.
 *
 * Each test holds its own paths as locals, so an assertion left running by a timed-out
 * test can only ever describe its own sandbox (#2306). These used to be module-level
 * `let` bindings reassigned in `beforeEach`, which let such an orphaned assertion read
 * the NEXT test's paths and report a mutation that never happened.
 */
async function createTempRoot(): Promise<string> {
  return trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-source-')));
}

async function createSandbox(): Promise<Sandbox> {
  const root = await createTempRoot();
  const sandbox: Sandbox = {
    root,
    source: join(root, 'authoring'),
    target: join(root, 'target'),
    runArtifacts: join(root, 'artifacts'),
  };
  await mkdir(join(sandbox.source, '.archon', 'workflows', 'pack', 'flow', 'commands'), {
    recursive: true,
  });
  await mkdir(join(sandbox.source, '.archon', 'commands'), { recursive: true });
  await mkdir(join(sandbox.source, '.archon', 'scripts'), { recursive: true });
  // A clean target: it is a real checkout, it just never held the authoring source.
  await mkdir(join(sandbox.target, '.archon', 'workflows'), { recursive: true });
  await mkdir(sandbox.runArtifacts, { recursive: true });
  return sandbox;
}

/**
 * Where a run's capture lands in a sandbox: BESIDE the artifacts tree, never inside it,
 * mirroring the layout the paths package owns (`<project>/workflow-source/runs/<id>`).
 */
const captureRootIn = (artifactsRoot: string, runId = 'run-1'): string =>
  join(dirname(artifactsRoot), 'workflow-source', 'runs', runId);

/**
 * Files captured under one scope.
 *
 * A capture also freezes the global and bundled scopes, whose size depends on the
 * machine running the test. Counting one scope keeps these assertions about the fixture.
 */
async function countScopeFiles(captureRoot: string, scope: string): Promise<number> {
  const walk = async (dir: string): Promise<number> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    let n = 0;
    for (const entry of entries) {
      n += entry.isDirectory() ? await walk(join(dir, entry.name)) : 1;
    }
    return n;
  };
  return walk(join(captureRoot, scope));
}

// Only `loadConfig` is read by loadCommandPrompt; the cast keeps the fixture minimal.
const deps = {
  loadConfig: () =>
    Promise.resolve({} as unknown as Awaited<ReturnType<WorkflowDeps['loadConfig']>>),
} satisfies Pick<WorkflowDeps, 'loadConfig'>;

describe('captureWorkflowSource', () => {
  test('freezes commands and scripts so the target never needs them', async () => {
    const { source, runArtifacts } = await createSandbox();
    await writeFile(join(source, '.archon', 'commands', 'review.md'), 'review the diff');
    await writeFile(join(source, '.archon', 'scripts', 'check.ts'), 'console.log("ok")');

    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: captureRootIn(runArtifacts),
    });

    expect(capture.origin).toBe(source);
    expect(await countScopeFiles(capture.anchor.root, 'project')).toBe(2);
    expect(
      await readFile(
        join(capture!.anchor.root, 'project', '.archon', 'commands', 'review.md'),
        'utf-8'
      )
    ).toBe('review the diff');
  });

  test('keeps a script tree whole so sibling imports and data still resolve', async () => {
    const { source, runArtifacts } = await createSandbox();
    // The reason a capture copies whole directories rather than the files a DAG names:
    // a script's imports and data reads are invisible to the workflow graph.
    await writeFile(join(source, '.archon', 'scripts', 'main.ts'), "import './helper';");
    await writeFile(join(source, '.archon', 'scripts', 'helper.ts'), 'export const x = 1;');
    await mkdir(join(source, '.archon', 'scripts', 'data'), { recursive: true });
    await writeFile(join(source, '.archon', 'scripts', 'data', 'fixture.json'), '{"a":1}');

    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: captureRootIn(runArtifacts),
    });

    const root2 = capture!.anchor.root;
    expect(
      await readFile(join(root2, 'project', '.archon', 'scripts', 'helper.ts'), 'utf-8')
    ).toContain('export const x');
    expect(
      await readFile(join(root2, 'project', '.archon', 'scripts', 'data', 'fixture.json'), 'utf-8')
    ).toBe('{"a":1}');
  });

  test('a later edit or deletion of the authoring source does not change the capture', async () => {
    const { source, runArtifacts } = await createSandbox();
    await writeFile(join(source, '.archon', 'commands', 'review.md'), 'original');
    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: captureRootIn(runArtifacts),
    });

    await writeFile(join(source, '.archon', 'commands', 'review.md'), 'EDITED');
    expect(
      await readFile(
        join(capture!.anchor.root, 'project', '.archon', 'commands', 'review.md'),
        'utf-8'
      )
    ).toBe('original');

    await rm(source, { recursive: true, force: true });
    expect(
      await readFile(
        join(capture!.anchor.root, 'project', '.archon', 'commands', 'review.md'),
        'utf-8'
      )
    ).toBe('original');
    expect((await loadWorkflowSource(capture!.anchor.root)).origin).toBe(source);
  });

  test('a fresh capture after an edit sees the new bytes', async () => {
    const { source, runArtifacts } = await createSandbox();
    await writeFile(join(source, '.archon', 'commands', 'review.md'), 'v1');
    const first = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: captureRootIn(runArtifacts, 'run-1'),
    });
    await writeFile(join(source, '.archon', 'commands', 'review.md'), 'v2');
    const second = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: captureRootIn(runArtifacts, 'run-2'),
    });

    expect(
      await readFile(join(first!.anchor.root, 'project/.archon/commands/review.md'), 'utf-8')
    ).toBe('v1');
    expect(
      await readFile(join(second!.anchor.root, 'project/.archon/commands/review.md'), 'utf-8')
    ).toBe('v2');
  });

  test('dereferences symlinks so nothing in the capture points back out', async () => {
    const { root, source, runArtifacts } = await createSandbox();
    const outside = join(root, 'outside.md');
    await writeFile(outside, 'external');
    await symlink(outside, join(source, '.archon', 'commands', 'linked.md'));

    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: captureRootIn(runArtifacts),
    });

    const copied = join(capture!.anchor.root, 'project', '.archon', 'commands', 'linked.md');
    expect((await stat(copied)).isFile()).toBe(true);
    // Mutating the link target must not reach the capture — that is the whole point.
    await writeFile(outside, 'CHANGED');
    expect(await readFile(copied, 'utf-8')).toBe('external');
  });

  test('keeps script dependencies but drops derived bytecode', async () => {
    const { source, runArtifacts } = await createSandbox();
    await writeFile(join(source, '.archon', 'scripts', 'main.py'), 'print(1)');
    await mkdir(join(source, '.archon', 'scripts', '__pycache__'), { recursive: true });
    await writeFile(join(source, '.archon', 'scripts', '__pycache__', 'main.pyc'), 'junk');
    await mkdir(join(source, '.archon', 'scripts', 'node_modules', 'dep'), { recursive: true });
    await writeFile(join(source, '.archon', 'scripts', 'node_modules', 'dep', 'i.js'), 'dep();');

    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: captureRootIn(runArtifacts),
    });

    // A packaged script may genuinely import from a sibling `node_modules`, so excluding
    // it produced a script that worked live and failed only once captured. `__pycache__`
    // is the opposite: derived, regenerated on demand, and a stale copy next to an edited
    // source can change behavior.
    expect(
      await readFile(
        join(capture.anchor.root, 'project/.archon/scripts/node_modules/dep/i.js'),
        'utf-8'
      )
    ).toBe('dep();');
    await expect(
      readFile(join(capture.anchor.root, 'project/.archon/scripts/__pycache__/main.pyc'), 'utf-8')
    ).rejects.toThrow();
  });

  test('cuts a directory symlink that points back into its own tree', async () => {
    const { source, runArtifacts } = await createSandbox();
    // Directory symlinks are FOLLOWED (that is what dereferencing means), so a link to an
    // ancestor re-enters the tree. Without a cycle guard the walk only stops when the
    // kernel refuses the path with ELOOP, having copied the same files at every level.
    await writeFile(join(source, '.archon', 'scripts', 'only.ts'), 'export const a = 1;');
    await mkdir(join(source, '.archon', 'scripts', 'sub'), { recursive: true });
    await symlink(
      join(source, '.archon', 'scripts'),
      join(source, '.archon', 'scripts', 'sub', 'loop')
    );

    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: captureRootIn(runArtifacts),
    });

    // Exactly one copy of the one real file — not one per level of re-entry.
    expect(await countScopeFiles(capture.anchor.root, 'project')).toBe(1);
  });

  test('captures nothing under project scope when the source holds none', async () => {
    const { root, runArtifacts } = await createSandbox();
    const empty = join(root, 'empty');
    await mkdir(empty, { recursive: true });
    const capture = await captureWorkflowSource({
      sourceRoot: empty,
      captureRoot: captureRootIn(runArtifacts),
    });
    // Still a valid, verifiable capture — a source with no project files is a legitimate
    // run (bundled workflows only), not a reason to leave the run without one.
    expect(capture.manifest.scopes).not.toContain('project');
    expect(await countScopeFiles(capture.anchor.root, 'project')).toBe(0);
    expect((await loadWorkflowSource(capture.anchor.root)).manifest.digest).toBe(
      capture.manifest.digest
    );
  });

  test('leaves no usable capture behind when it cannot finish', async () => {
    const { source, runArtifacts } = await createSandbox();
    await writeFile(join(source, '.archon', 'commands', 'review.md'), 'x');
    const captureRoot = captureRootIn(runArtifacts);
    // A file where the staging directory must go: the copy fails part-way through.
    // The capture creates this parent itself; the blocker has to be planted first.
    await mkdir(dirname(captureRoot), { recursive: true });
    await writeFile(`${captureRoot}.partial`, 'in the way');

    await expect(
      captureWorkflowSource({ sourceRoot: source, captureRoot })
    ).resolves.not.toBeNull();
    // (rm -f clears the blocker, so this proves the staging path is reclaimed rather
    // than left to poison the next capture.)
    await expect(
      readFile(join(`${captureRoot}.partial`, 'manifest.json'), 'utf-8')
    ).rejects.toThrow();
  });

  test('replaces a stale capture rather than merging two vintages', async () => {
    const { source, runArtifacts } = await createSandbox();
    const captureRoot = captureRootIn(runArtifacts);
    await writeFile(join(source, '.archon', 'commands', 'gone.md'), 'old');
    await captureWorkflowSource({ sourceRoot: source, captureRoot });

    await rm(join(source, '.archon', 'commands', 'gone.md'));
    await writeFile(join(source, '.archon', 'commands', 'new.md'), 'new');
    await captureWorkflowSource({ sourceRoot: source, captureRoot });

    expect((await loadWorkflowSource(captureRoot)).manifest.version).toBe(1);
    await expect(
      readFile(join(captureRoot, 'project/.archon/commands/gone.md'), 'utf-8')
    ).rejects.toThrow();
    expect(await readFile(join(captureRoot, 'project/.archon/commands/new.md'), 'utf-8')).toBe(
      'new'
    );
  });
});

describe('the bundled scope is hoisted out of the per-capture path', () => {
  /**
   * The bundled bytes are read once per process and written into every capture from
   * memory, which is only safe while a later capture still sees an edit to the trees they
   * were read from. In a source build those trees are the checkout's own
   * `.archon/workflows` and `.archon/commands`, and a running Archon writes there itself:
   * `PUT`/`DELETE /api/workflows/:name` land under `<cwd>/.archon/workflows`, which for a
   * maintainer running Archon from source IS the checkout. Serving a memoized catalogue
   * there would be a wrong answer, not a slow one.
   *
   * The mocked bundled root is this file's shared empty tree, so the file this writes into
   * it is removed again before the test returns.
   */
  test('a later capture in the same process sees a bundled-scope edit', async () => {
    const { source, runArtifacts, root } = await createSandbox();
    const bundledFile = join(bundledDefaultsRoot, 'defaults', 'late-bundled-edit.yaml');
    const capturedAt = (capture: { anchor: { root: string } }): string =>
      join(capture.anchor.root, 'bundled', 'workflows', 'defaults', 'late-bundled-edit.yaml');
    // The digests below are compared to each other, so the global scope has to be a tree
    // this test owns rather than whatever `~/.archon` holds while the suite runs.
    const previousHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = join(root, 'home');

    try {
      const before = await captureWorkflowSource({
        sourceRoot: source,
        captureRoot: captureRootIn(runArtifacts, 'before'),
      });
      await expect(readFile(capturedAt(before), 'utf-8')).rejects.toThrow();

      // A file that did not exist when the first capture ran.
      await writeFile(bundledFile, 'name: late-bundled-edit\n');
      const added = await captureWorkflowSource({
        sourceRoot: source,
        captureRoot: captureRootIn(runArtifacts, 'added'),
      });
      expect(await readFile(capturedAt(added), 'utf-8')).toBe('name: late-bundled-edit\n');
      expect(added.manifest.digest).not.toBe(before.manifest.digest);

      // An edit in place: same path, new bytes. Size and mtime are what catch this.
      await writeFile(bundledFile, 'name: late-bundled-edit\ndescription: edited\n');
      const edited = await captureWorkflowSource({
        sourceRoot: source,
        captureRoot: captureRootIn(runArtifacts, 'edited'),
      });
      expect(await readFile(capturedAt(edited), 'utf-8')).toBe(
        'name: late-bundled-edit\ndescription: edited\n'
      );
      expect(edited.manifest.digest).not.toBe(added.manifest.digest);

      // And a removal.
      await rm(bundledFile, { force: true });
      const removed = await captureWorkflowSource({
        sourceRoot: source,
        captureRoot: captureRootIn(runArtifacts, 'removed'),
      });
      await expect(readFile(capturedAt(removed), 'utf-8')).rejects.toThrow();
      expect(removed.manifest.digest).toBe(before.manifest.digest);
    } finally {
      await rm(bundledFile, { force: true });
      if (previousHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = previousHome;
    }
  });

  /**
   * The digest is a PERSISTED value. A capture taken by an older build is re-verified by
   * this one on every read, so any change to how per-file hashes are ordered or folded
   * reads as tampering and refuses the resume of every paused run on disk.
   *
   * The fixture below is a capture as an older build wrote it, carrying the digest that
   * build recorded. `pack-extra.yaml` beside the `pack/` directory is the case that makes
   * ordering observable: `/` and the platform separator sort differently against `-`, so a
   * fold that sorted normalized paths instead of platform ones would pass on POSIX and
   * change every Windows digest.
   */
  test('a capture from an older build still verifies against its recorded digest', async () => {
    const captureRoot = join(await createTempRoot(), 'runs', 'legacy-run');
    const files: readonly (readonly [string, string])[] = [
      ['project/.archon/workflows/alpha.yaml', 'name: alpha\n'],
      ['project/.archon/workflows/pack-extra.yaml', 'name: pack-extra\n'],
      ['project/.archon/workflows/pack/flow/beta.yaml', 'name: beta\n'],
      ['project/.archon/commands/do.md', '# do\n'],
      ['global/scripts/run.sh', 'echo hi\n'],
      ['bundled/workflows/defaults/bundled.yaml', 'name: bundled\n'],
      ['bundled/commands/defaults/bundled.md', '# bundled\n'],
    ];
    for (const [relPath, content] of files) {
      const target = join(captureRoot, ...relPath.split('/'));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    const digest = '8622a93dc7846a9b6bb977235940555166e11d507839e84f74c35c7f17c0a03d';
    await writeFile(
      join(captureRoot, 'manifest.json'),
      `${JSON.stringify({
        version: 1,
        engine_version: '0.0.0-legacy',
        origin: '/somewhere/else',
        captured_at: '2026-01-01T00:00:00.000Z',
        digest,
        file_count: files.length,
        byte_count: 77,
        scopes: ['project', 'global', 'bundled'],
        source_config: DEFAULT_WORKFLOW_SOURCE_CONFIG,
      })}\n`
    );

    const capture = await loadWorkflowSource(captureRoot, digest);
    expect(capture.manifest.digest).toBe(digest);
  });
});

describe('resolving against a capture instead of the target', () => {
  test('a command resolves from the source even though the target lacks it', async () => {
    const { source, target, runArtifacts } = await createSandbox();
    await writeFile(join(source, '.archon', 'commands', 'review.md'), 'from authoring');
    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: captureRootIn(runArtifacts),
    });

    // Without a source root the target is searched, and the target never had it.
    const fromTarget = await loadCommandPrompt(deps, target, 'review');
    expect(fromTarget.success).toBe(false);

    const fromCapture = await loadCommandPrompt(
      deps,
      target,
      'review',
      undefined,
      capturedSourceRoots(capture!.anchor)
    );
    expect(fromCapture).toEqual({ success: true, content: 'from authoring' });
  });

  test('a packaged command resolves from the source under its owner identity', async () => {
    const { source, target, runArtifacts } = await createSandbox();
    await writeFile(
      join(source, '.archon', 'workflows', 'pack', 'flow', 'commands', 'step.md'),
      'packaged body'
    );
    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: captureRootIn(runArtifacts),
    });

    const result = await loadCommandPrompt(
      deps,
      target,
      '__archon_pack__project:pack:flow::step',
      undefined,
      capturedSourceRoots(capture!.anchor)
    );
    expect(result).toEqual({ success: true, content: 'packaged body' });
  });

  test('a named script resolves from the source, at a path outside the target', async () => {
    const { source, target, runArtifacts } = await createSandbox();
    await writeFile(join(source, '.archon', 'scripts', 'check.ts'), 'console.log(1)');
    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: captureRootIn(runArtifacts),
    });

    expect((await discoverScriptsForCwd(target)).get('check')).toBeUndefined();

    const script = (await discoverScriptsForCwd(target, capturedSourceRoots(capture!.anchor))).get(
      'check'
    );
    expect(script?.runtime).toBe('bun');
    // The script runs from the capture while the process still works in the target.
    // `discoverScripts` returns POSIX-separated paths on every platform (normalizeSep),
    // so compare in that form rather than against a raw `join()` result.
    const posix = (p: string) => p.replaceAll('\\', '/');
    expect(script?.path.startsWith(posix(capture!.anchor.root))).toBe(true);
    expect(script?.path.startsWith(posix(target))).toBe(false);
  });

  test('the target cannot shadow a command the run captured', async () => {
    const { source, target, runArtifacts } = await createSandbox();
    await writeFile(join(source, '.archon', 'commands', 'review.md'), 'authoring version');
    await mkdir(join(target, '.archon', 'commands'), { recursive: true });
    await writeFile(join(target, '.archon', 'commands', 'review.md'), 'TARGET VERSION');

    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: captureRootIn(runArtifacts),
    });
    const result = await loadCommandPrompt(
      deps,
      target,
      'review',
      undefined,
      capturedSourceRoots(capture!.anchor)
    );
    expect(result).toEqual({ success: true, content: 'authoring version' });
  });
});

describe("a run's own source versus a child's discovery root", () => {
  /** The metadata a run carries once it has captured. */
  const recorded = (
    root: string,
    origin: string,
    digest = 'x',
    sourceConfig?: WorkflowSourceConfig
  ): Record<string, unknown> => ({
    [WORKFLOW_SOURCE_METADATA_KEY]: {
      version: 1,
      root,
      origin,
      captured_at: '2026-08-21T00:00:00.000Z',
      digest,
      ...(sourceConfig !== undefined ? { source_config: sourceConfig } : {}),
      file_count: 1,
      byte_count: 1,
    },
  });

  test('a run reloads its OWN graph from the frozen copy, not from authoring', async () => {
    const { source, runArtifacts } = await createSandbox();
    await writeFile(join(source, '.archon', 'commands', 'c.md'), 'x');
    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: captureRootIn(runArtifacts),
    });
    const metadata = recorded(capture!.anchor.root, source, capture!.manifest.digest);

    expect((await resolveRunSourceCapture(metadata))?.anchor.root).toBe(capture!.anchor.root);
  });

  test('new and pre-change version-1 records both remain readable', async () => {
    const root = await createTempRoot();
    const oldRecord = recorded(root, root);
    const newRecord = recorded(root, root, 'x', DEFAULT_WORKFLOW_SOURCE_CONFIG);

    const oldState = readWorkflowSourceState(oldRecord);
    expect(oldState.kind).toBe('recorded');
    if (oldState.kind === 'recorded') {
      expect('source_config' in oldState.record).toBe(false);
    }
    expect(readWorkflowSourceState(newRecord)).toMatchObject({
      kind: 'recorded',
      record: { source_config: DEFAULT_WORKFLOW_SOURCE_CONFIG },
    });
  });

  test('a not-yet-started child resolves from LIVE authoring, so a fix can land', async () => {
    const { source, runArtifacts } = await createSandbox();
    // The load-bearing difference. A `workflow:` child is not a run until it starts, so
    // freezing it into the parent would make an authoring fix — removing a gate from a
    // child workflow and resuming the parent — permanently ineffective.
    await writeFile(join(source, '.archon', 'commands', 'c.md'), 'x');
    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: captureRootIn(runArtifacts),
    });
    const metadata = recorded(capture!.anchor.root, source, capture!.manifest.digest);

    expect(await resolveChildDiscoveryRoot(metadata)).toBe(source);
    expect(await resolveChildDiscoveryRoot(metadata)).not.toBe(
      await resolveRunSourceCapture(metadata)
    );
  });

  test('a recorded run and its not-yet-started child fail when their source is gone', async () => {
    const root = await createTempRoot();
    const metadata = recorded(join(root, 'no-capture'), join(root, 'no-origin'));
    await expect(resolveRunSourceCapture(metadata)).rejects.toThrow(WorkflowSourceIntegrityError);
    await expect(resolveChildDiscoveryRoot(metadata)).rejects.toThrow(
      'recorded authoring source is unavailable'
    );
  });

  test('a run with no recorded source resolves live', async () => {
    expect(await resolveRunSourceCapture({})).toBeUndefined();
    expect(await resolveChildDiscoveryRoot(undefined)).toBeUndefined();
  });

  test('a relative recorded path fails closed rather than resolving against process.cwd', async () => {
    const relative = {
      [WORKFLOW_SOURCE_METADATA_KEY]: {
        version: 1,
        root: 'artifacts/runs/x/workflow-source',
        origin: 'some/where',
        captured_at: '2026-08-21T00:00:00.000Z',
        digest: 'x',
        file_count: 1,
        byte_count: 1,
      },
    };
    // Unreadable, not absent: the run DID record a source, so resolving live would
    // execute something it never agreed to.
    await expect(resolveRunSourceCapture(relative)).rejects.toThrow(WorkflowSourceIntegrityError);
    await expect(resolveChildDiscoveryRoot(relative)).rejects.toThrow(WorkflowSourceIntegrityError);
  });

  test('a record from a newer Archon fails closed rather than resuming live', async () => {
    const { source } = await createSandbox();
    // The tempting mistake is to treat "I cannot parse this" as "there is nothing here".
    // Only a genuinely absent record — a run predating capture — may resume live.
    const future = { [WORKFLOW_SOURCE_METADATA_KEY]: { version: 99, root: source } };
    await expect(resolveRunSourceCapture(future)).rejects.toThrow(WorkflowSourceIntegrityError);
    expect(await resolveRunSourceCapture({})).toBeUndefined();
  });
});

describe('the capture is authoritative, not advisory', () => {
  test('initial discovery refuses a capture changed after its anchor was pinned', async () => {
    const { source, target, runArtifacts } = await createSandbox();
    const workflowPath = join(source, '.archon', 'workflows', 'anchored.yaml');
    await writeFile(
      workflowPath,
      [
        'name: anchored',
        'description: source integrity fixture',
        'nodes:',
        '  - id: check',
        '    bash: echo original',
      ].join('\n')
    );
    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: captureRootIn(runArtifacts),
    });
    await writeFile(
      join(capture.anchor.root, 'project', '.archon', 'workflows', 'anchored.yaml'),
      'name: replacement\ndescription: changed\nnodes: []\n'
    );

    await expect(
      discoverWorkflows(target, { sourceRoots: capturedSourceRoots(capture.anchor) })
    ).rejects.toThrow(WorkflowSourceIntegrityError);
  });

  test('a tampered capture fails to load instead of executing quietly', async () => {
    const { source, runArtifacts } = await createSandbox();
    await writeFile(join(source, '.archon', 'commands', 'review.md'), 'original');
    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: captureRootIn(runArtifacts),
    });

    // An edit UNDER the artifacts tree: a directory-exists check cannot see this, which
    // is the whole reason the manifest carries a digest.
    await writeFile(
      join(capture.anchor.root, 'project', '.archon', 'commands', 'review.md'),
      'TAMPERED'
    );

    await expect(loadWorkflowSource(capture.anchor.root)).rejects.toThrow(
      WorkflowSourceIntegrityError
    );
  });

  test('a run whose capture no longer verifies refuses to resolve a source root', async () => {
    const { source, runArtifacts } = await createSandbox();
    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: captureRootIn(runArtifacts),
    });
    const metadata = {
      [WORKFLOW_SOURCE_METADATA_KEY]: {
        version: 1,
        root: capture.anchor.root,
        origin: source,
        captured_at: capture.manifest.captured_at,
        digest: capture.manifest.digest,
        file_count: capture.manifest.file_count,
        byte_count: capture.manifest.byte_count,
      },
    };
    expect((await resolveRunSourceCapture(metadata))?.anchor.root).toBe(capture.anchor.root);

    await rm(capture.anchor.root, { recursive: true, force: true });
    // Not `undefined` — that would read as "no record" and fall through to live source.
    await expect(resolveRunSourceCapture(metadata)).rejects.toThrow(WorkflowSourceIntegrityError);
  });

  test('an internally consistent replacement is rejected by the retained digest', async () => {
    const { source, runArtifacts } = await createSandbox();
    const captureRoot = captureRootIn(runArtifacts);
    await writeFile(join(source, '.archon', 'commands', 'review.md'), 'original');
    const original = await captureWorkflowSource({ sourceRoot: source, captureRoot });

    await writeFile(join(source, '.archon', 'commands', 'review.md'), 'replacement');
    await captureWorkflowSource({ sourceRoot: source, captureRoot });

    await expect(
      assertWorkflowSourceIntegrity(capturedSourceRoots(original.anchor))
    ).rejects.toThrow('capture has been replaced');
  });

  test('a new run rejects source config drift even when the tree digest still matches', async () => {
    const { source, runArtifacts } = await createSandbox();
    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: captureRootIn(runArtifacts),
      sourceConfig: DEFAULT_WORKFLOW_SOURCE_CONFIG,
    });
    const changedConfig: WorkflowSourceConfig = {
      ...DEFAULT_WORKFLOW_SOURCE_CONFIG,
      load_default_commands: false,
    };
    const manifestPath = join(capture.anchor.root, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as Record<string, unknown>;
    await writeFile(
      manifestPath,
      `${JSON.stringify({ ...manifest, source_config: changedConfig }, null, 2)}\n`
    );
    const metadata = {
      [WORKFLOW_SOURCE_METADATA_KEY]: {
        version: 1,
        root: capture.anchor.root,
        origin: source,
        captured_at: capture.manifest.captured_at,
        digest: capture.manifest.digest,
        source_config: DEFAULT_WORKFLOW_SOURCE_CONFIG,
        file_count: capture.manifest.file_count,
        byte_count: capture.manifest.byte_count,
      },
    };

    await expect(resolveRunSourceCapture(metadata)).rejects.toThrow(
      'different resolution settings'
    );
  });

  test('a pre-change run pins verified manifest config for the resumed process', async () => {
    const { source, runArtifacts } = await createSandbox();
    const sourceConfig: WorkflowSourceConfig = {
      ...DEFAULT_WORKFLOW_SOURCE_CONFIG,
      command_folder: 'team-commands',
    };
    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: captureRootIn(runArtifacts),
      sourceConfig,
    });
    const metadata = {
      [WORKFLOW_SOURCE_METADATA_KEY]: {
        version: 1,
        root: capture.anchor.root,
        origin: source,
        captured_at: capture.manifest.captured_at,
        digest: capture.manifest.digest,
        file_count: capture.manifest.file_count,
        byte_count: capture.manifest.byte_count,
      },
    };

    const resumed = await resolveRunSourceCapture(metadata);
    if (!resumed) throw new Error('expected the recorded capture to resolve');
    expect(resumed.anchor.config).toEqual(sourceConfig);
    expect(
      (metadata[WORKFLOW_SOURCE_METADATA_KEY] as Record<string, unknown>).source_config
    ).toBeUndefined();

    const manifestPath = join(capture.anchor.root, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as Record<string, unknown>;
    await writeFile(
      manifestPath,
      `${JSON.stringify({ ...manifest, source_config: DEFAULT_WORKFLOW_SOURCE_CONFIG }, null, 2)}\n`
    );
    await expect(
      assertWorkflowSourceIntegrity(capturedSourceRoots(resumed.anchor))
    ).rejects.toThrow('different resolution settings');
  });

  test('freezes every statically reachable scope, not just the project', async () => {
    const { source, runArtifacts } = await createSandbox();
    await writeFile(join(source, '.archon', 'commands', 'review.md'), 'x');
    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: captureRootIn(runArtifacts),
    });
    // A project workflow can `include:` a global or bundled one, so leaving those live
    // would let an included workflow change shape across a resume.
    expect(capture.manifest.scopes).toContain('project');
    // Named explicitly because this file redirects the bundle getters at an EMPTY tree to
    // keep capture cost off the Windows budget (#2882). That lever is only safe while an
    // empty bundled tree is still SCANNED and recorded; if it ever silently stopped being
    // captured, every other assertion here would keep passing.
    expect(capture.manifest.scopes).toContain('bundled');
    const roots = capturedSourceRoots(capture.anchor);
    expect(roots.globalWorkflows.startsWith(capture.anchor.root)).toBe(true);
    expect(roots.globalCommands.startsWith(capture.anchor.root)).toBe(true);
  });

  test('records the selected workflow without disturbing what was frozen', async () => {
    const { source, runArtifacts } = await createSandbox();
    await writeFile(join(source, '.archon', 'commands', 'review.md'), 'x');
    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: captureRootIn(runArtifacts),
    });

    await recordSelectedWorkflow(capture.anchor.root, 'chosen-flow');

    // The manifest is outside the digest, so naming the selection cannot invalidate it.
    const reloaded = await loadWorkflowSource(capture.anchor.root);
    expect(reloaded.manifest.workflow_name).toBe('chosen-flow');
    expect(reloaded.manifest.digest).toBe(capture.manifest.digest);
  });
});

describe("the source's own settings travel with its bytes", () => {
  test('a custom commands.folder is captured and resolves from the capture', async () => {
    const { source, target, runArtifacts } = await createSandbox();
    // Discovery honors `commands.folder`, so a capture taken without it finds the command
    // at selection time and loses it at execution time.
    await mkdir(join(source, 'team-commands'), { recursive: true });
    await writeFile(join(source, 'team-commands', 'shipit.md'), 'ship it');

    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: captureRootIn(runArtifacts),
      commandFolder: 'team-commands',
      sourceConfig: {
        load_default_workflows: true,
        load_default_commands: true,
        command_folder: 'team-commands',
      },
    });

    expect(capture.manifest.source_config.command_folder).toBe('team-commands');

    // Resolved with the TARGET's cwd and no target-side folder setting: the only way this
    // finds the command is by using the folder the capture recorded.
    const result = await loadCommandPrompt(
      deps,
      target,
      'shipit',
      undefined,
      capturedSourceRoots(capture.anchor)
    );
    expect(result).toEqual({ success: true, content: 'ship it' });
  });

  test('without the recorded folder the same command is not found', async () => {
    const { source, target, runArtifacts } = await createSandbox();
    await mkdir(join(source, 'team-commands'), { recursive: true });
    await writeFile(join(source, 'team-commands', 'shipit.md'), 'ship it');
    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: captureRootIn(runArtifacts),
      commandFolder: 'team-commands',
    });

    // Default config — the folder was captured but the settings were not recorded.
    const result = await loadCommandPrompt(
      deps,
      target,
      'shipit',
      undefined,
      capturedSourceRoots({ ...capture.anchor, config: DEFAULT_WORKFLOW_SOURCE_CONFIG })
    );
    expect(result.success).toBe(false);
  });
});

describe('continuing a run resolves with the settings it froze', () => {
  test('the manifest supplies the config, so a custom command folder survives resume', async () => {
    const { source, target, runArtifacts } = await createSandbox();
    // The regression: continuation built roots with DEFAULT_WORKFLOW_SOURCE_CONFIG, which
    // is worse than degraded — a defined-but-default config also suppresses discovery's
    // live-config fallback, so the result is confidently wrong.
    await mkdir(join(source, 'team-commands'), { recursive: true });
    await writeFile(join(source, 'team-commands', 'shipit.md'), 'ship it');
    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: captureRootIn(runArtifacts),
      commandFolder: 'team-commands',
      sourceConfig: {
        load_default_workflows: true,
        load_default_commands: true,
        command_folder: 'team-commands',
      },
    });

    // What a continuation does: read the capture back from its path alone, exactly as
    // `sourceCaptureRoot` gives it, and rebuild roots from the manifest it finds there.
    const reloaded = await loadWorkflowSource(capture.anchor.root);
    const roots = capturedSourceRoots(reloaded.anchor);
    expect(roots.anchor.config.command_folder).toBe('team-commands');

    const result = await loadCommandPrompt(deps, target, 'shipit', undefined, roots);
    expect(result).toEqual({ success: true, content: 'ship it' });
  });
});

describe('a capture is adopted or reclaimed, whichever way the caller leaves', () => {
  /** Stand in for a staged capture: what the owner is handed and may have to reclaim. */
  async function stage(
    root: string,
    name: string
  ): Promise<{
    anchor: {
      root: string;
      digest: string;
      config: WorkflowSourceConfig;
    };
  }> {
    const captureRoot = join(root, name);
    await mkdir(captureRoot, { recursive: true });
    await writeFile(join(captureRoot, 'manifest.json'), '{}');
    return {
      anchor: {
        root: captureRoot,
        digest: 'test-digest',
        config: DEFAULT_WORKFLOW_SOURCE_CONFIG,
      },
    };
  }

  const exists = async (p: string): Promise<boolean> =>
    readFile(join(p, 'manifest.json'), 'utf-8').then(
      () => true,
      () => false
    );

  test('reclaims when the body returns without adopting', async () => {
    const root = await createTempRoot();
    // The shape of every early exit that used to leak: an unknown workflow, a refused
    // input contract, the "resume or force?" menu. None of them adopt.
    let staged: Awaited<ReturnType<typeof stage>> | undefined;
    await withCapturedSource(async owner => {
      staged = await stage(root, 'returned');
      owner.hold(staged);
    });
    expect(await exists(staged!.anchor.root)).toBe(false);
  });

  test('reclaims when the body throws', async () => {
    const root = await createTempRoot();
    let staged: Awaited<ReturnType<typeof stage>> | undefined;
    await expect(
      withCapturedSource(async owner => {
        staged = await stage(root, 'threw');
        owner.hold(staged);
        throw new Error('a gate refused this run');
      })
    ).rejects.toThrow('a gate refused this run');
    expect(await exists(staged!.anchor.root)).toBe(false);
  });

  test('leaves an adopted capture alone — a run owns it now', async () => {
    const root = await createTempRoot();
    let staged: Awaited<ReturnType<typeof stage>> | undefined;
    await withCapturedSource(async owner => {
      staged = await stage(root, 'adopted');
      owner.hold(staged);
      owner.adopt();
    });
    expect(await exists(staged!.anchor.root)).toBe(true);
  });

  test('reclaims the CURRENT path after a container run moves the capture', async () => {
    const root = await createTempRoot();
    // `finalizeWorkflowSource` moves a container run's capture out of staging early. If
    // the owner kept tracking the pre-move path it would reclaim a directory that is
    // already gone and leave the real one behind, looking like it had cleaned up.
    let moved: Awaited<ReturnType<typeof stage>> | undefined;
    await withCapturedSource(async owner => {
      const staged = await stage(root, 'pre-move');
      owner.hold(staged);
      moved = await stage(root, 'post-move');
      owner.hold(moved);
    });
    expect(await exists(moved!.anchor.root)).toBe(false);
  });

  test('holding nothing is not an error', async () => {
    await expect(withCapturedSource(async () => 'no capture taken')).resolves.toBe(
      'no capture taken'
    );
  });
});
