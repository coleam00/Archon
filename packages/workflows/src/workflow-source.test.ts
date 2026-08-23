/**
 * Source capture: what a run freezes, and what it must keep resolving after the
 * authoring checkout moves on.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir, symlink, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  captureWorkflowSource,
  capturedSourceRoots,
  getRunSourceCapturePath,
  loadWorkflowSource,
  recordSelectedWorkflow,
  resolveChildDiscoveryRoot,
  resolveRunSourceCapture,
  WorkflowSourceIntegrityError,
  DEFAULT_WORKFLOW_SOURCE_CONFIG,
} from './workflow-source';
import { WORKFLOW_SOURCE_METADATA_KEY } from './schemas/workflow-run';
import { discoverScriptsForCwd } from './script-discovery';
import { loadCommandPrompt } from './executor-shared';
import { withCapturedSource } from './executor';
import type { WorkflowDeps } from './deps';

let root: string;
let source: string;
let target: string;
let runArtifacts: string;

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

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archon-source-'));
  source = join(root, 'authoring');
  target = join(root, 'target');
  runArtifacts = join(root, 'artifacts');
  await mkdir(join(source, '.archon', 'workflows', 'pack', 'flow', 'commands'), {
    recursive: true,
  });
  await mkdir(join(source, '.archon', 'commands'), { recursive: true });
  await mkdir(join(source, '.archon', 'scripts'), { recursive: true });
  // A clean target: it is a real checkout, it just never held the authoring source.
  await mkdir(join(target, '.archon', 'workflows'), { recursive: true });
  await mkdir(runArtifacts, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('captureWorkflowSource', () => {
  test('freezes commands and scripts so the target never needs them', async () => {
    await writeFile(join(source, '.archon', 'commands', 'review.md'), 'review the diff');
    await writeFile(join(source, '.archon', 'scripts', 'check.ts'), 'console.log("ok")');

    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: getRunSourceCapturePath(runArtifacts),
    });

    expect(capture.origin).toBe(source);
    expect(await countScopeFiles(capture.captureRoot, 'project')).toBe(2);
    expect(
      await readFile(
        join(capture!.captureRoot, 'project', '.archon', 'commands', 'review.md'),
        'utf-8'
      )
    ).toBe('review the diff');
  });

  test('keeps a script tree whole so sibling imports and data still resolve', async () => {
    // The reason a capture copies whole directories rather than the files a DAG names:
    // a script's imports and data reads are invisible to the workflow graph.
    await writeFile(join(source, '.archon', 'scripts', 'main.ts'), "import './helper';");
    await writeFile(join(source, '.archon', 'scripts', 'helper.ts'), 'export const x = 1;');
    await mkdir(join(source, '.archon', 'scripts', 'data'), { recursive: true });
    await writeFile(join(source, '.archon', 'scripts', 'data', 'fixture.json'), '{"a":1}');

    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: getRunSourceCapturePath(runArtifacts),
    });

    const root2 = capture!.captureRoot;
    expect(
      await readFile(join(root2, 'project', '.archon', 'scripts', 'helper.ts'), 'utf-8')
    ).toContain('export const x');
    expect(
      await readFile(join(root2, 'project', '.archon', 'scripts', 'data', 'fixture.json'), 'utf-8')
    ).toBe('{"a":1}');
  });

  test('a later edit or deletion of the authoring source does not change the capture', async () => {
    await writeFile(join(source, '.archon', 'commands', 'review.md'), 'original');
    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: getRunSourceCapturePath(runArtifacts),
    });

    await writeFile(join(source, '.archon', 'commands', 'review.md'), 'EDITED');
    expect(
      await readFile(
        join(capture!.captureRoot, 'project', '.archon', 'commands', 'review.md'),
        'utf-8'
      )
    ).toBe('original');

    await rm(source, { recursive: true, force: true });
    expect(
      await readFile(
        join(capture!.captureRoot, 'project', '.archon', 'commands', 'review.md'),
        'utf-8'
      )
    ).toBe('original');
    expect((await loadWorkflowSource(capture!.captureRoot)).origin).toBe(source);
  });

  test('a fresh capture after an edit sees the new bytes', async () => {
    await writeFile(join(source, '.archon', 'commands', 'review.md'), 'v1');
    const first = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: join(runArtifacts, 'run-1', 'workflow-source'),
    });
    await writeFile(join(source, '.archon', 'commands', 'review.md'), 'v2');
    const second = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: join(runArtifacts, 'run-2', 'workflow-source'),
    });

    expect(
      await readFile(join(first!.captureRoot, 'project/.archon/commands/review.md'), 'utf-8')
    ).toBe('v1');
    expect(
      await readFile(join(second!.captureRoot, 'project/.archon/commands/review.md'), 'utf-8')
    ).toBe('v2');
  });

  test('dereferences symlinks so nothing in the capture points back out', async () => {
    const outside = join(root, 'outside.md');
    await writeFile(outside, 'external');
    await symlink(outside, join(source, '.archon', 'commands', 'linked.md'));

    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: getRunSourceCapturePath(runArtifacts),
    });

    const copied = join(capture!.captureRoot, 'project', '.archon', 'commands', 'linked.md');
    expect((await stat(copied)).isFile()).toBe(true);
    // Mutating the link target must not reach the capture — that is the whole point.
    await writeFile(outside, 'CHANGED');
    expect(await readFile(copied, 'utf-8')).toBe('external');
  });

  test('keeps script dependencies but drops derived bytecode', async () => {
    await writeFile(join(source, '.archon', 'scripts', 'main.py'), 'print(1)');
    await mkdir(join(source, '.archon', 'scripts', '__pycache__'), { recursive: true });
    await writeFile(join(source, '.archon', 'scripts', '__pycache__', 'main.pyc'), 'junk');
    await mkdir(join(source, '.archon', 'scripts', 'node_modules', 'dep'), { recursive: true });
    await writeFile(join(source, '.archon', 'scripts', 'node_modules', 'dep', 'i.js'), 'dep();');

    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: getRunSourceCapturePath(runArtifacts),
    });

    // A packaged script may genuinely import from a sibling `node_modules`, so excluding
    // it produced a script that worked live and failed only once captured. `__pycache__`
    // is the opposite: derived, regenerated on demand, and a stale copy next to an edited
    // source can change behavior.
    expect(
      await readFile(
        join(capture.captureRoot, 'project/.archon/scripts/node_modules/dep/i.js'),
        'utf-8'
      )
    ).toBe('dep();');
    await expect(
      readFile(join(capture.captureRoot, 'project/.archon/scripts/__pycache__/main.pyc'), 'utf-8')
    ).rejects.toThrow();
  });

  test('cuts a directory symlink that points back into its own tree', async () => {
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
      captureRoot: getRunSourceCapturePath(runArtifacts),
    });

    // Exactly one copy of the one real file — not one per level of re-entry.
    expect(await countScopeFiles(capture.captureRoot, 'project')).toBe(1);
  });

  test('captures nothing under project scope when the source holds none', async () => {
    const empty = join(root, 'empty');
    await mkdir(empty, { recursive: true });
    const capture = await captureWorkflowSource({
      sourceRoot: empty,
      captureRoot: getRunSourceCapturePath(runArtifacts),
    });
    // Still a valid, verifiable capture — a source with no project files is a legitimate
    // run (bundled workflows only), not a reason to leave the run without one.
    expect(capture.manifest.scopes).not.toContain('project');
    expect(await countScopeFiles(capture.captureRoot, 'project')).toBe(0);
    expect((await loadWorkflowSource(capture.captureRoot)).manifest.digest).toBe(
      capture.manifest.digest
    );
  });

  test('leaves no usable capture behind when it cannot finish', async () => {
    await writeFile(join(source, '.archon', 'commands', 'review.md'), 'x');
    const captureRoot = getRunSourceCapturePath(runArtifacts);
    // A file where the staging directory must go: the copy fails part-way through.
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
    const captureRoot = getRunSourceCapturePath(runArtifacts);
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

describe('resolving against a capture instead of the target', () => {
  test('a command resolves from the source even though the target lacks it', async () => {
    await writeFile(join(source, '.archon', 'commands', 'review.md'), 'from authoring');
    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: getRunSourceCapturePath(runArtifacts),
    });

    // Without a source root the target is searched, and the target never had it.
    const fromTarget = await loadCommandPrompt(deps, target, 'review');
    expect(fromTarget.success).toBe(false);

    const fromCapture = await loadCommandPrompt(
      deps,
      target,
      'review',
      undefined,
      capturedSourceRoots(capture!.captureRoot, capture!.manifest.source_config)
    );
    expect(fromCapture).toEqual({ success: true, content: 'from authoring' });
  });

  test('a packaged command resolves from the source under its owner identity', async () => {
    await writeFile(
      join(source, '.archon', 'workflows', 'pack', 'flow', 'commands', 'step.md'),
      'packaged body'
    );
    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: getRunSourceCapturePath(runArtifacts),
    });

    const result = await loadCommandPrompt(
      deps,
      target,
      '__archon_pack__project:pack:flow::step',
      undefined,
      capturedSourceRoots(capture!.captureRoot, capture!.manifest.source_config)
    );
    expect(result).toEqual({ success: true, content: 'packaged body' });
  });

  test('a named script resolves from the source, at a path outside the target', async () => {
    await writeFile(join(source, '.archon', 'scripts', 'check.ts'), 'console.log(1)');
    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: getRunSourceCapturePath(runArtifacts),
    });

    expect((await discoverScriptsForCwd(target)).get('check')).toBeUndefined();

    const script = (
      await discoverScriptsForCwd(
        target,
        capturedSourceRoots(capture!.captureRoot, capture!.manifest.source_config)
      )
    ).get('check');
    expect(script?.runtime).toBe('bun');
    // The script runs from the capture while the process still works in the target.
    // `discoverScripts` returns POSIX-separated paths on every platform (normalizeSep),
    // so compare in that form rather than against a raw `join()` result.
    const posix = (p: string) => p.replaceAll('\\', '/');
    expect(script?.path.startsWith(posix(capture!.captureRoot))).toBe(true);
    expect(script?.path.startsWith(posix(target))).toBe(false);
  });

  test('the target cannot shadow a command the run captured', async () => {
    await writeFile(join(source, '.archon', 'commands', 'review.md'), 'authoring version');
    await mkdir(join(target, '.archon', 'commands'), { recursive: true });
    await writeFile(join(target, '.archon', 'commands', 'review.md'), 'TARGET VERSION');

    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: getRunSourceCapturePath(runArtifacts),
    });
    const result = await loadCommandPrompt(
      deps,
      target,
      'review',
      undefined,
      capturedSourceRoots(capture!.captureRoot, capture!.manifest.source_config)
    );
    expect(result).toEqual({ success: true, content: 'authoring version' });
  });
});

describe("a run's own source versus a child's discovery root", () => {
  /** The metadata a run carries once it has captured. */
  const recorded = (root: string, origin: string, digest = 'x'): Record<string, unknown> => ({
    [WORKFLOW_SOURCE_METADATA_KEY]: {
      version: 1,
      root,
      origin,
      captured_at: '2026-08-21T00:00:00.000Z',
      digest,
      file_count: 1,
      byte_count: 1,
    },
  });

  test('a run reloads its OWN graph from the frozen copy, not from authoring', async () => {
    await writeFile(join(source, '.archon', 'commands', 'c.md'), 'x');
    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: getRunSourceCapturePath(runArtifacts),
    });
    const metadata = recorded(capture!.captureRoot, source, capture!.manifest.digest);

    expect((await resolveRunSourceCapture(metadata))?.captureRoot).toBe(capture!.captureRoot);
  });

  test('a not-yet-started child resolves from LIVE authoring, so a fix can land', async () => {
    // The load-bearing difference. A `workflow:` child is not a run until it starts, so
    // freezing it into the parent would make an authoring fix — removing a gate from a
    // child workflow and resuming the parent — permanently ineffective.
    await writeFile(join(source, '.archon', 'commands', 'c.md'), 'x');
    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: getRunSourceCapturePath(runArtifacts),
    });
    const metadata = recorded(capture!.captureRoot, source, capture!.manifest.digest);

    expect(await resolveChildDiscoveryRoot(metadata)).toBe(source);
    expect(await resolveChildDiscoveryRoot(metadata)).not.toBe(
      await resolveRunSourceCapture(metadata)
    );
  });

  test('a recorded run FAILS when its capture is gone; a child falls back to live', async () => {
    // The asymmetry is the contract. A run that recorded a source must execute that
    // source or stop — falling back would resume it against different bytes. A child's
    // origin is only a hint about where to capture FROM, so its absence is recoverable.
    const metadata = recorded(join(root, 'no-capture'), join(root, 'no-origin'));
    await expect(resolveRunSourceCapture(metadata)).rejects.toThrow(WorkflowSourceIntegrityError);
    expect(await resolveChildDiscoveryRoot(metadata)).toBeUndefined();
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
    expect(await resolveChildDiscoveryRoot(relative)).toBeUndefined();
  });

  test('a record from a newer Archon fails closed rather than resuming live', async () => {
    // The tempting mistake is to treat "I cannot parse this" as "there is nothing here".
    // Only a genuinely absent record — a run predating capture — may resume live.
    const future = { [WORKFLOW_SOURCE_METADATA_KEY]: { version: 99, root: source } };
    await expect(resolveRunSourceCapture(future)).rejects.toThrow(WorkflowSourceIntegrityError);
    expect(await resolveRunSourceCapture({})).toBeUndefined();
  });
});

describe('the capture is authoritative, not advisory', () => {
  test('a tampered capture fails to load instead of executing quietly', async () => {
    await writeFile(join(source, '.archon', 'commands', 'review.md'), 'original');
    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: getRunSourceCapturePath(runArtifacts),
    });

    // An edit UNDER the artifacts tree: a directory-exists check cannot see this, which
    // is the whole reason the manifest carries a digest.
    await writeFile(
      join(capture.captureRoot, 'project', '.archon', 'commands', 'review.md'),
      'TAMPERED'
    );

    await expect(loadWorkflowSource(capture.captureRoot)).rejects.toThrow(
      WorkflowSourceIntegrityError
    );
  });

  test('a run whose capture no longer verifies refuses to resolve a source root', async () => {
    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: getRunSourceCapturePath(runArtifacts),
    });
    const metadata = {
      [WORKFLOW_SOURCE_METADATA_KEY]: {
        version: 1,
        root: capture.captureRoot,
        origin: source,
        captured_at: capture.manifest.captured_at,
        digest: capture.manifest.digest,
        file_count: capture.manifest.file_count,
        byte_count: capture.manifest.byte_count,
      },
    };
    expect((await resolveRunSourceCapture(metadata))?.captureRoot).toBe(capture.captureRoot);

    await rm(capture.captureRoot, { recursive: true, force: true });
    // Not `undefined` — that would read as "no record" and fall through to live source.
    await expect(resolveRunSourceCapture(metadata)).rejects.toThrow(WorkflowSourceIntegrityError);
  });

  test('freezes every statically reachable scope, not just the project', async () => {
    await writeFile(join(source, '.archon', 'commands', 'review.md'), 'x');
    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: getRunSourceCapturePath(runArtifacts),
    });
    // A project workflow can `include:` a global or bundled one, so leaving those live
    // would let an included workflow change shape across a resume.
    expect(capture.manifest.scopes).toContain('project');
    const roots = capturedSourceRoots(capture.captureRoot, capture.manifest.source_config);
    expect(roots.globalWorkflows.startsWith(capture.captureRoot)).toBe(true);
    expect(roots.globalCommands.startsWith(capture.captureRoot)).toBe(true);
  });

  test('records the selected workflow without disturbing what was frozen', async () => {
    await writeFile(join(source, '.archon', 'commands', 'review.md'), 'x');
    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: getRunSourceCapturePath(runArtifacts),
    });

    await recordSelectedWorkflow(capture.captureRoot, 'chosen-flow');

    // The manifest is outside the digest, so naming the selection cannot invalidate it.
    const reloaded = await loadWorkflowSource(capture.captureRoot);
    expect(reloaded.manifest.workflow_name).toBe('chosen-flow');
    expect(reloaded.manifest.digest).toBe(capture.manifest.digest);
  });
});

describe("the source's own settings travel with its bytes", () => {
  test('a custom commands.folder is captured and resolves from the capture', async () => {
    // Discovery honors `commands.folder`, so a capture taken without it finds the command
    // at selection time and loses it at execution time.
    await mkdir(join(source, 'team-commands'), { recursive: true });
    await writeFile(join(source, 'team-commands', 'shipit.md'), 'ship it');

    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: getRunSourceCapturePath(runArtifacts),
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
      capturedSourceRoots(capture.captureRoot, capture.manifest.source_config)
    );
    expect(result).toEqual({ success: true, content: 'ship it' });
  });

  test('without the recorded folder the same command is not found', async () => {
    await mkdir(join(source, 'team-commands'), { recursive: true });
    await writeFile(join(source, 'team-commands', 'shipit.md'), 'ship it');
    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: getRunSourceCapturePath(runArtifacts),
      commandFolder: 'team-commands',
    });

    // Default config — the folder was captured but the settings were not recorded.
    const result = await loadCommandPrompt(
      deps,
      target,
      'shipit',
      undefined,
      capturedSourceRoots(capture.captureRoot, DEFAULT_WORKFLOW_SOURCE_CONFIG)
    );
    expect(result.success).toBe(false);
  });
});

describe('continuing a run resolves with the settings it froze', () => {
  test('the manifest supplies the config, so a custom command folder survives resume', async () => {
    // The regression: continuation built roots with DEFAULT_WORKFLOW_SOURCE_CONFIG, which
    // is worse than degraded — a defined-but-default config also suppresses discovery's
    // live-config fallback, so the result is confidently wrong.
    await mkdir(join(source, 'team-commands'), { recursive: true });
    await writeFile(join(source, 'team-commands', 'shipit.md'), 'ship it');
    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: getRunSourceCapturePath(runArtifacts),
      commandFolder: 'team-commands',
      sourceConfig: {
        load_default_workflows: true,
        load_default_commands: true,
        command_folder: 'team-commands',
      },
    });

    // What a continuation does: read the capture back from its path alone, exactly as
    // `sourceCaptureRoot` gives it, and rebuild roots from the manifest it finds there.
    const reloaded = await loadWorkflowSource(capture.captureRoot);
    const roots = capturedSourceRoots(reloaded.captureRoot, reloaded.manifest.source_config);
    expect(roots.config.command_folder).toBe('team-commands');

    const result = await loadCommandPrompt(deps, target, 'shipit', undefined, roots);
    expect(result).toEqual({ success: true, content: 'ship it' });
  });
});

describe('a capture is adopted or reclaimed, whichever way the caller leaves', () => {
  /** Stand in for a staged capture: what the owner is handed and may have to reclaim. */
  async function stage(name: string): Promise<{ captureRoot: string }> {
    const captureRoot = join(root, name);
    await mkdir(captureRoot, { recursive: true });
    await writeFile(join(captureRoot, 'manifest.json'), '{}');
    return { captureRoot };
  }

  const exists = async (p: string): Promise<boolean> =>
    readFile(join(p, 'manifest.json'), 'utf-8').then(
      () => true,
      () => false
    );

  test('reclaims when the body returns without adopting', async () => {
    // The shape of every early exit that used to leak: an unknown workflow, a refused
    // input contract, the "resume or force?" menu. None of them adopt.
    let staged: { captureRoot: string } | undefined;
    await withCapturedSource(async owner => {
      staged = await stage('returned');
      owner.hold(staged);
    });
    expect(await exists(staged!.captureRoot)).toBe(false);
  });

  test('reclaims when the body throws', async () => {
    let staged: { captureRoot: string } | undefined;
    await expect(
      withCapturedSource(async owner => {
        staged = await stage('threw');
        owner.hold(staged);
        throw new Error('a gate refused this run');
      })
    ).rejects.toThrow('a gate refused this run');
    expect(await exists(staged!.captureRoot)).toBe(false);
  });

  test('leaves an adopted capture alone — a run owns it now', async () => {
    let staged: { captureRoot: string } | undefined;
    await withCapturedSource(async owner => {
      staged = await stage('adopted');
      owner.hold(staged);
      owner.adopt();
    });
    expect(await exists(staged!.captureRoot)).toBe(true);
  });

  test('reclaims the CURRENT path after a container run moves the capture', async () => {
    // `finalizeWorkflowSource` moves a container run's capture out of staging early. If
    // the owner kept tracking the pre-move path it would reclaim a directory that is
    // already gone and leave the real one behind, looking like it had cleaned up.
    let moved: { captureRoot: string } | undefined;
    await withCapturedSource(async owner => {
      const staged = await stage('pre-move');
      owner.hold(staged);
      moved = await stage('post-move');
      owner.hold(moved);
    });
    expect(await exists(moved!.captureRoot)).toBe(false);
  });

  test('holding nothing is not an error', async () => {
    await expect(withCapturedSource(async () => 'no capture taken')).resolves.toBe(
      'no capture taken'
    );
  });

  test('reclaims a staged capture when executeWorkflow fails to rename it into place (#2690)', async () => {
    // The rename-failure branch of `executeWorkflow` returns a failure result WITHOUT
    // calling `owner.adopt()` — adoption only happens after the durable move succeeds.
    // Simulating that here is what proves the contract the issue asks for: a rename
    // failure leaves the wrap's `finally` to reclaim, instead of orphaning the staged
    // tree for the hourly age-based sweep. The wrap body never adopts, so this is the
    // pre-#2690 "body returns without adopting" test, replayed through the surface
    // the failure path actually takes (rename throws / returns / fails before adopt).
    let staged: { captureRoot: string } | undefined;
    await withCapturedSource(async owner => {
      staged = await stage('rename-failed');
      owner.hold(staged);
      // Mirror the executor: a rename failure returns without adopting.
      return { success: false, workflowRunId: 'x', error: 'rename failed' } as const;
    });
    expect(await exists(staged!.captureRoot)).toBe(false);
  });
});
