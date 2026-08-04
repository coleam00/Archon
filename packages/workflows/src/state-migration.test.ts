/**
 * Tests for the legacy `.archon/state/` migration warning (#2200).
 *
 * The whole contract is "detect, warn once, never touch" — so the assertions
 * are: exactly one warn, the right event name, an actionable `mv`, an escalated
 * message inside a worktree, and ZERO filesystem mutation.
 */
import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, rm, readdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const warnCalls: { payload: Record<string, unknown>; event: string }[] = [];
const mockLogger = {
  info: mock(() => {}),
  warn: mock((payload: Record<string, unknown>, event: string) => {
    warnCalls.push({ payload, event });
  }),
  error: mock(() => {}),
  debug: mock(() => {}),
  trace: mock(() => {}),
  fatal: mock(() => {}),
  child: mock(() => mockLogger),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

import {
  maybeWarnLegacyStatePath,
  maybeWarnLegacyArtifactsPath,
  resetLegacyStateWarningForTests,
} from './state-migration';

let dir: string;

beforeEach(async () => {
  warnCalls.length = 0;
  resetLegacyStateWarningForTests();
  dir = await mkdtemp(join(tmpdir(), 'archon-state-migration-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('maybeWarnLegacyStatePath', () => {
  it('is silent when no legacy .archon/state exists (ENOENT happy path)', async () => {
    await maybeWarnLegacyStatePath(dir, '/out/root/state', false);
    expect(warnCalls).toHaveLength(0);
  });

  it('warns once with an actionable mv when the legacy directory exists', async () => {
    const legacy = join(dir, '.archon', 'state');
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, 'triage-state.json'), '{}');

    await maybeWarnLegacyStatePath(dir, '/out/root/state', false);

    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0].event).toBe('workflow.legacy_state_path_detected');
    expect(warnCalls[0].payload.legacyPath).toBe(legacy);
    expect(warnCalls[0].payload.newPath).toBe('/out/root/state');
    expect(String(warnCalls[0].payload.moveCommand)).toContain('mv ');
    expect(String(warnCalls[0].payload.moveCommand)).toContain(legacy);
  });

  it('probes each project independently — one project cannot suppress another', async () => {
    // Regression guard: a process-wide latch meant the first run in a server
    // process (any project, legacy dir or not) silenced detection everywhere.
    const other = await mkdtemp(join(tmpdir(), 'archon-state-migration-other-'));
    await mkdir(join(other, '.archon', 'state'), { recursive: true });
    try {
      // A project with NO legacy dir goes first and must not latch the check.
      await maybeWarnLegacyStatePath(dir, '/out/root/state', false);
      expect(warnCalls).toHaveLength(0);

      await maybeWarnLegacyStatePath(other, '/out/other/state', false);

      expect(warnCalls).toHaveLength(1);
      expect(warnCalls[0].payload.legacyPath).toBe(join(other, '.archon', 'state'));
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it('a cwd with no legacy dir does not consume its own latch', async () => {
    // Mutation guard: with the latch set BEFORE the probe (the earlier shape),
    // the first silent call burns the latch for this cwd and a legacy directory
    // appearing later in the same process is never reported. The cross-project
    // test above does NOT kill that mutant — this one does.
    await maybeWarnLegacyStatePath(dir, '/out/root/state', false);
    expect(warnCalls).toHaveLength(0);

    await mkdir(join(dir, '.archon', 'state'), { recursive: true });
    await maybeWarnLegacyStatePath(dir, '/out/root/state', false);

    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0].event).toBe('workflow.legacy_state_path_detected');
  });

  it('warns exactly once across concurrent workflow starts', async () => {
    await mkdir(join(dir, '.archon', 'state'), { recursive: true });

    await Promise.all([
      maybeWarnLegacyStatePath(dir, '/out/root', false),
      maybeWarnLegacyStatePath(dir, '/out/root', false),
      maybeWarnLegacyStatePath(dir, '/out/root', false),
    ]);

    expect(warnCalls).toHaveLength(1);
  });

  it('escalates the wording for an isolated (worktree) run', async () => {
    await mkdir(join(dir, '.archon', 'state'), { recursive: true });

    await maybeWarnLegacyStatePath(dir, '/out/root/state', true);

    expect(warnCalls).toHaveLength(1);
    // Same event name, distinct message + an isolated flag: inside a worktree
    // the directory is destroyed at cleanup, which is the actual data loss.
    expect(warnCalls[0].event).toBe('workflow.legacy_state_path_detected');
    expect(warnCalls[0].payload.isolated).toBe(true);
    expect(String(warnCalls[0].payload.message)).toContain('ISOLATED');
  });

  it('does not warn for a worktree run that has no legacy directory (correct $STATE_DIR use)', async () => {
    // The intended case: an isolated run using $STATE_DIR. Worktree-ness alone
    // must never trigger the warning, or it fires on every correct use.
    await maybeWarnLegacyStatePath(dir, '/out/root/state', true);
    expect(warnCalls).toHaveLength(0);
  });

  it('never moves, creates, or deletes anything', async () => {
    const legacy = join(dir, '.archon', 'state');
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, 'old.json'), '{"seen":1}');
    const stateDir = join(dir, 'output-root', 'state');

    await maybeWarnLegacyStatePath(dir, stateDir, true);

    expect(await readdir(legacy)).toEqual(['old.json']);
    // The destination is NOT created as a side effect of the probe.
    await expect(readdir(stateDir)).rejects.toThrow();
  });
});

// #2311: the state relocation Archon never caused got a detector; the artifacts/logs
// relocation the ENGINE caused on the unregistered-cwd fallback got nothing. These
// cover the detector that closes that asymmetry.
describe('maybeWarnLegacyArtifactsPath', () => {
  it('is silent when no legacy .archon/artifacts or logs exists', async () => {
    await maybeWarnLegacyArtifactsPath(dir, '/out/root/artifacts', false);
    expect(warnCalls).toHaveLength(0);
  });

  it('warns once, naming both legacy directories when both are present', async () => {
    await mkdir(join(dir, '.archon', 'artifacts'), { recursive: true });
    await mkdir(join(dir, '.archon', 'logs'), { recursive: true });

    await maybeWarnLegacyArtifactsPath(dir, '/out/root/artifacts', false);
    await maybeWarnLegacyArtifactsPath(dir, '/out/root/artifacts', false);

    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0].event).toBe('workflow.legacy_artifacts_path_detected');
    expect(warnCalls[0].payload.legacyPaths).toEqual([
      join(dir, '.archon', 'artifacts'),
      join(dir, '.archon', 'logs'),
    ]);
  });

  it('fires when only logs is present (artifacts alone is not the trigger)', async () => {
    await mkdir(join(dir, '.archon', 'logs'), { recursive: true });

    await maybeWarnLegacyArtifactsPath(dir, '/out/root/artifacts', false);

    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0].payload.legacyPaths).toEqual([join(dir, '.archon', 'logs')]);
  });

  // An isolated run's cwd IS the worktree, so those files were already dying at
  // teardown — nothing is lost. In place they survive in the user's own repo and are
  // merely unlisted. Same detection, materially different news.
  it('tells an isolated run nothing is lost, and an in-place run the files remain', async () => {
    await mkdir(join(dir, '.archon', 'artifacts'), { recursive: true });

    await maybeWarnLegacyArtifactsPath(dir, '/out/root/artifacts', true);
    expect(String(warnCalls[0].payload.message)).toContain('nothing is lost');

    resetLegacyStateWarningForTests();
    warnCalls.length = 0;

    await maybeWarnLegacyArtifactsPath(dir, '/out/root/artifacts', false);
    expect(String(warnCalls[0].payload.message)).toContain('still on disk');
  });

  // A repo can have one legacy directory and not the other. A shared latch would let
  // whichever probe ran first permanently suppress the other.
  it('latches independently of the state probe', async () => {
    await mkdir(join(dir, '.archon', 'state'), { recursive: true });
    await mkdir(join(dir, '.archon', 'artifacts'), { recursive: true });

    await maybeWarnLegacyStatePath(dir, '/out/root/state', false);
    await maybeWarnLegacyArtifactsPath(dir, '/out/root/artifacts', false);

    expect(warnCalls.map(c => c.event)).toEqual([
      'workflow.legacy_state_path_detected',
      'workflow.legacy_artifacts_path_detected',
    ]);
  });
});
