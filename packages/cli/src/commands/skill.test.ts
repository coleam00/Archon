/**
 * Tests for skill install command
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempTree } from '@archon/paths/test-utils';
import { BUNDLED_SKILL_FILES } from '../bundled-skill';
import { copyArchonSkill, skillInstallCommand } from './skill';

describe('copyArchonSkill', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'archon-skill-test-'));
  });

  afterEach(async () => {
    await removeTempTree(tempDir);
  });

  it('creates missing parents and writes exact bundled content in both destinations', async () => {
    const target = join(tempDir, 'missing-parent', 'project');
    expect(existsSync(target)).toBe(false);
    await copyArchonSkill(target);

    for (const root of ['.claude', '.agents']) {
      const skillRoot = join(target, root, 'skills', 'archon-cli');
      for (const [relativePath, content] of Object.entries(BUNDLED_SKILL_FILES)) {
        expect(readFileSync(join(skillRoot, relativePath), 'utf-8')).toBe(content);
      }
    }
  });

  it('bundles active cancel guidance without the obsolete abandon mapping', () => {
    const content = BUNDLED_SKILL_FILES['manage-run/manage-runs.md'];
    expect(content).toContain('archon workflow cancel <run-id>');
    expect(content).toContain('archon workflow abandon <run-id>');
    expect(content).toContain('archon workflow respond <run-id>');
    expect(content).not.toContain('there is no `archon workflow cancel` CLI subcommand');
    expect(content).not.toContain('There is no separate `cancel` verb');
    expect(content).not.toContain('cancel via reject');
    expect(content).not.toContain('Reject (cancels the workflow)');
  });

  it('overwrites pre-existing skill files with bundled content in both destinations', async () => {
    for (const root of ['.claude', '.agents']) {
      const skillRoot = join(tempDir, root, 'skills', 'archon-cli');
      mkdirSync(skillRoot, { recursive: true });
      writeFileSync(join(skillRoot, 'SKILL.md'), 'STALE');
    }

    await copyArchonSkill(tempDir);

    for (const root of ['.claude', '.agents']) {
      expect(readFileSync(join(tempDir, root, 'skills', 'archon-cli', 'SKILL.md'), 'utf-8')).toBe(
        BUNDLED_SKILL_FILES['SKILL.md']
      );
    }
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

  afterEach(async () => {
    await removeTempTree(tempDir);
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
