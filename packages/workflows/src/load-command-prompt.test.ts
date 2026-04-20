import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as realPaths from '@archon/paths';

// Mock only the logger so test output stays clean. All other @archon/paths
// exports (findMarkdownFilesRecursive, getHomeCommandsPath, etc.) use real
// implementations — loadCommandPrompt exercises them against a tmp dir set
// via ARCHON_HOME below.
const mockLogFn = mock(() => {});
const mockLogger = {
  info: mockLogFn,
  warn: mockLogFn,
  error: mockLogFn,
  debug: mockLogFn,
  trace: mockLogFn,
  fatal: mockLogFn,
  child: mock(() => mockLogger),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};
mock.module('@archon/paths', () => ({
  ...realPaths,
  createLogger: mock(() => mockLogger),
}));

import { loadCommandPrompt } from './executor-shared';
import type { WorkflowDeps } from './deps';

// Minimal deps stub — loadCommandPrompt only calls loadConfig.
function makeDeps(loadDefaultCommands = true): WorkflowDeps {
  return {
    loadConfig: async () => ({ defaults: { loadDefaultCommands } }),
  } as unknown as WorkflowDeps;
}

describe('loadCommandPrompt — home-scope resolution', () => {
  let archonHome: string;
  let repoRoot: string;
  let prevArchonHome: string | undefined;

  beforeEach(() => {
    prevArchonHome = process.env.ARCHON_HOME;
    // Separate tmp dirs for home and repo so they don't collide.
    archonHome = mkdtempSync(join(tmpdir(), 'archon-home-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'archon-repo-'));
    process.env.ARCHON_HOME = archonHome;
    mkdirSync(join(archonHome, 'commands'), { recursive: true });
    mkdirSync(join(repoRoot, '.archon', 'commands'), { recursive: true });
  });

  afterEach(() => {
    if (prevArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = prevArchonHome;
    rmSync(archonHome, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('resolves a command from ~/.archon/commands/ when repo has none', async () => {
    writeFileSync(join(archonHome, 'commands', 'personal-helper.md'), 'Personal helper body');

    const result = await loadCommandPrompt(makeDeps(false), repoRoot, 'personal-helper');

    expect(result.success).toBe(true);
    if (result.success) expect(result.content).toBe('Personal helper body');
  });

  it('repo command shadows home command with the same name', async () => {
    writeFileSync(join(archonHome, 'commands', 'shared.md'), 'HOME version');
    writeFileSync(join(repoRoot, '.archon', 'commands', 'shared.md'), 'REPO version');

    const result = await loadCommandPrompt(makeDeps(false), repoRoot, 'shared');

    expect(result.success).toBe(true);
    if (result.success) expect(result.content).toBe('REPO version');
  });

  it('resolves a home command inside a 1-level subfolder by basename', async () => {
    mkdirSync(join(archonHome, 'commands', 'triage'), { recursive: true });
    writeFileSync(join(archonHome, 'commands', 'triage', 'review.md'), 'Review body');

    const result = await loadCommandPrompt(makeDeps(false), repoRoot, 'review');

    expect(result.success).toBe(true);
    if (result.success) expect(result.content).toBe('Review body');
  });

  it('does NOT resolve home commands buried >1 level deep', async () => {
    mkdirSync(join(archonHome, 'commands', 'a', 'b'), { recursive: true });
    writeFileSync(join(archonHome, 'commands', 'a', 'b', 'too-deep.md'), 'too deep');

    const result = await loadCommandPrompt(makeDeps(false), repoRoot, 'too-deep');

    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe('not_found');
  });

  it('returns not_found when neither repo nor home has the command (defaults off)', async () => {
    const result = await loadCommandPrompt(makeDeps(false), repoRoot, 'missing');

    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe('not_found');
  });

  it('surfaces empty_file for a zero-byte home command', async () => {
    writeFileSync(join(archonHome, 'commands', 'blank.md'), '');

    const result = await loadCommandPrompt(makeDeps(false), repoRoot, 'blank');

    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe('empty_file');
  });
});
