/**
 * Tests for skill install command
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BUNDLED_SKILL_FILES } from '../bundled-skill';
import { copyArchonSkill, skillInstallCommand } from './skill';

describe('copyArchonSkill', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'archon-skill-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes every bundled skill file under .claude/skills/archon-cli/', async () => {
    await copyArchonSkill(tempDir);

    const skillRoot = join(tempDir, '.claude', 'skills', 'archon-cli');
    for (const [relativePath, content] of Object.entries(BUNDLED_SKILL_FILES)) {
      const dest = join(skillRoot, relativePath);
      expect(existsSync(dest)).toBe(true);
      expect(readFileSync(dest, 'utf-8')).toBe(content);
    }
  });

  it('writes every bundled skill file under .agents/skills/archon-cli/ (Codex path)', async () => {
    await copyArchonSkill(tempDir);

    const skillRoot = join(tempDir, '.agents', 'skills', 'archon-cli');
    for (const [relativePath, content] of Object.entries(BUNDLED_SKILL_FILES)) {
      const dest = join(skillRoot, relativePath);
      expect(existsSync(dest)).toBe(true);
      expect(readFileSync(dest, 'utf-8')).toBe(content);
    }
  });

  it('installs active cancel guidance without the obsolete abandon mapping', async () => {
    await copyArchonSkill(tempDir);

    const guidance = [
      join(tempDir, '.claude', 'skills', 'archon-cli', 'manage-run', 'manage-runs.md'),
      join(tempDir, '.agents', 'skills', 'archon-cli', 'manage-run', 'manage-runs.md'),
    ].map(path => readFileSync(path, 'utf-8'));

    for (const content of guidance) {
      expect(content).toContain('archon workflow cancel <run-id>');
      expect(content).toContain('archon workflow abandon <run-id>');
      expect(content).toContain('archon workflow respond <run-id>');
      expect(content).not.toContain('there is no `archon workflow cancel` CLI subcommand');
      expect(content).not.toContain('There is no separate `cancel` verb');
      expect(content).not.toContain('cancel via reject');
      expect(content).not.toContain('Reject (cancels the workflow)');
    }
    expect(guidance[0]).toContain('archon workflow abandon <run-id>');
    expect(guidance[0]).toContain('archon workflow respond <run-id>');
  });

  it('overwrites pre-existing skill files with bundled content', async () => {
    const skillRoot = join(tempDir, '.claude', 'skills', 'archon-cli');
    const skillMdPath = join(skillRoot, 'SKILL.md');

    // Pre-seed with stale content; copyArchonSkill must overwrite it.
    await copyArchonSkill(tempDir);
    writeFileSync(skillMdPath, 'STALE');
    expect(readFileSync(skillMdPath, 'utf-8')).toBe('STALE');

    await copyArchonSkill(tempDir);
    expect(readFileSync(skillMdPath, 'utf-8')).toBe(BUNDLED_SKILL_FILES['SKILL.md']);
  });

  it('removes obsolete skills from both supported skill roots during upgrades', async () => {
    for (const root of ['.claude', '.agents']) {
      const skillsRoot = join(tempDir, root, 'skills');
      const obsoleteRoots = [join(skillsRoot, 'archon'), join(skillsRoot, 'manage-run')];
      for (const obsoleteRoot of obsoleteRoots) {
        mkdirSync(obsoleteRoot, { recursive: true });
        writeFileSync(join(obsoleteRoot, 'SKILL.md'), 'STALE');
      }
    }

    await copyArchonSkill(tempDir);

    for (const root of ['.claude', '.agents']) {
      const skillsRoot = join(tempDir, root, 'skills');
      expect(existsSync(join(skillsRoot, 'archon'))).toBe(false);
      expect(existsSync(join(skillsRoot, 'manage-run'))).toBe(false);
      expect(existsSync(join(skillsRoot, 'archon-cli', 'SKILL.md'))).toBe(true);
    }
  });
});

describe('skillInstallCommand', () => {
  let tempDir: string;
  let logSpy: ReturnType<typeof spyOn>;
  let errSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'archon-skill-cmd-test-'));
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('returns 0 and installs the skill into the target directory', async () => {
    const exitCode = await skillInstallCommand(tempDir);

    expect(exitCode).toBe(0);
    expect(existsSync(join(tempDir, '.claude', 'skills', 'archon-cli', 'SKILL.md'))).toBe(true);
    // Also installs into the Codex path
    expect(existsSync(join(tempDir, '.agents', 'skills', 'archon-cli', 'SKILL.md'))).toBe(true);
    // Final log line should mention restarting both Claude Code and Codex
    const lastLog = logSpy.mock.calls.at(-1)?.[0] as string | undefined;
    expect(lastLog).toContain('Restart Claude Code or Codex');
  });

  it('returns 1 and prints an error when the target directory does not exist', async () => {
    const missing = join(tempDir, 'does-not-exist');
    const exitCode = await skillInstallCommand(missing);

    expect(exitCode).toBe(1);
    expect(errSpy).toHaveBeenCalled();
    const firstError = errSpy.mock.calls[0][0] as string;
    expect(firstError).toContain('Directory does not exist');
    // Nothing should have been written to either path
    expect(existsSync(join(missing, '.claude'))).toBe(false);
    expect(existsSync(join(missing, '.agents'))).toBe(false);
  });
});
