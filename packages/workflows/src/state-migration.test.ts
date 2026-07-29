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

import { maybeWarnLegacyStatePath, resetLegacyStateWarningForTests } from './state-migration';

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
    await maybeWarnLegacyStatePath(dir, '/out/root', false);
    expect(warnCalls).toHaveLength(0);
  });

  it('warns once with an actionable mv when the legacy directory exists', async () => {
    const legacy = join(dir, '.archon', 'state');
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, 'triage-state.json'), '{}');

    await maybeWarnLegacyStatePath(dir, '/out/root', false);

    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0].event).toBe('workflow.legacy_state_path_detected');
    expect(warnCalls[0].payload.legacyPath).toBe(legacy);
    expect(warnCalls[0].payload.newPath).toBe(join('/out/root', 'state'));
    expect(String(warnCalls[0].payload.moveCommand)).toContain('mv ');
    expect(String(warnCalls[0].payload.moveCommand)).toContain(legacy);
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

    await maybeWarnLegacyStatePath(dir, '/out/root', true);

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
    await maybeWarnLegacyStatePath(dir, '/out/root', true);
    expect(warnCalls).toHaveLength(0);
  });

  it('never moves, creates, or deletes anything', async () => {
    const legacy = join(dir, '.archon', 'state');
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, 'old.json'), '{"seen":1}');
    const outputRoot = join(dir, 'output-root');

    await maybeWarnLegacyStatePath(dir, outputRoot, true);

    expect(await readdir(legacy)).toEqual(['old.json']);
    // The destination is NOT created as a side effect of the probe.
    await expect(readdir(outputRoot)).rejects.toThrow();
  });
});
