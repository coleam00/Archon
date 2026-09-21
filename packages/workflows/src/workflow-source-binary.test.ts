/**
 * A compiled binary's capture has to stand on its own.
 *
 * A binary keeps its bundled workflows, commands, and scripts as embedded constants rather
 * than files. Left that way, a capture could not include them, so a run that statically
 * included a bundled workflow had no way to prove on resume that it had not changed under
 * an Archon upgrade — and the only safe answer was to refuse the resume outright. That
 * refused every paused binary run across every upgrade, whether or not it touched bundled
 * content.
 *
 * Writing the constants into the capture turns an unprovable case into an ordinary digest
 * check. These tests run with `isBinaryBuild()` forced true, because that branch is
 * otherwise unreachable from a source checkout.
 *
 * Own file, own `bun test` invocation: `mock.module` is process-global and irreversible,
 * and pretending to be a binary would poison every other suite in the process.
 */
import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import { cp, mkdtemp, mkdir, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempTree } from '@archon/paths/test-utils';

const actual = await import('./defaults/bundled-defaults');
mock.module('./defaults/bundled-defaults', () => ({ ...actual, isBinaryBuild: () => true }));

const { captureWorkflowSource, capturedSourceRoots, loadWorkflowSource } =
  await import('./workflow-source');
const { loadCommandPrompt } = await import('./executor-shared');
const { discoverScriptsForCwd } = await import('./script-discovery');

let root: string;
let target: string;
let capture: Awaited<ReturnType<typeof captureWorkflowSource>>;

const deps = {
  loadConfig: () => Promise.resolve({} as unknown as Awaited<ReturnType<() => Promise<never>>>),
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'archon-binary-source-'));
  const source = join(root, 'authoring');
  target = join(root, 'target');
  await mkdir(join(source, '.archon', 'workflows'), { recursive: true });
  await mkdir(target, { recursive: true });
  // The readers share one immutable real bundle; the tamper case copies it below.
  capture = await captureWorkflowSource({
    sourceRoot: source,
    captureRoot: join(root, 'capture'),
  });
});

afterAll(async () => {
  await removeTempTree(root);
});

describe('a binary freezes its embedded bundled source', () => {
  test('the capture claims the bundled scope, which a binary never could before', async () => {
    // Without materialization this is absent in a binary, and absence is what forced the
    // resume-blocking engine-version check that used to live here.
    expect(capture.manifest.scopes).toContain('bundled');
  });

  test('a bundled command exists as a file and resolves from the capture', async () => {
    const onDisk = await readFile(
      join(capture.anchor.root, 'bundled', 'commands', 'defaults', 'archon-assist.md'),
      'utf-8'
    );
    expect(onDisk.length).toBeGreaterThan(0);

    // Resolved against the TARGET's cwd: the only way this succeeds is by reading the
    // capture, because the target has no `.archon` of its own.
    const result = await loadCommandPrompt(
      deps as never,
      target,
      'archon-assist',
      undefined,
      capturedSourceRoots(capture.anchor)
    );
    expect(result.success).toBe(true);
  });

  test('bundled workflows are written where discovery expects them', async () => {
    const roots = capturedSourceRoots(capture.anchor);
    const yaml = await readFile(
      join(roots.bundledWorkflows, 'defaults', 'archon-assist.yaml'),
      'utf-8'
    );
    expect(yaml).toContain('name: archon-assist');
  });

  test('script discovery reads the capture rather than re-materializing constants', async () => {
    // A captured run must read scripts from its frozen roots.
    const roots = capturedSourceRoots(capture.anchor);
    expect(roots.kind).toBe('captured');
    await expect(discoverScriptsForCwd(target, roots)).resolves.toBeInstanceOf(Map);
  });

  test('the digest covers the bundled bytes, so an upgrade cannot change them unnoticed', async () => {
    // Verifies end to end — this is what replaced refusing the resume outright.
    const loaded = await loadWorkflowSource(capture.anchor.root, capture.manifest.digest);
    expect(loaded.manifest.digest).toBe(capture.manifest.digest);

    // Mutate a copy so this test cannot alter what the other readers observe.
    const tamperedRoot = join(root, 'tampered-capture');
    await cp(capture.anchor.root, tamperedRoot, { recursive: true });
    const { writeFile } = await import('fs/promises');
    await writeFile(
      join(tamperedRoot, 'bundled', 'commands', 'defaults', 'archon-assist.md'),
      'swapped by a different Archon build'
    );
    await expect(loadWorkflowSource(tamperedRoot, capture.manifest.digest)).rejects.toThrow();
  });
});
