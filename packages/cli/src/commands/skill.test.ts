/**
 * Tests for skill install command
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BUNDLED_MANAGE_RUN_SKILL_FILES, BUNDLED_SKILL_FILES } from '../bundled-skill';
import { copyArchonSkill, skillInstallCommand } from './skill';

const SKILL_DESCRIPTION_MAX_CHARS = 1024;

function extractFrontmatter(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  if (lines[0] !== '---') {
    throw new Error('missing frontmatter');
  }

  const endIndex = lines.findIndex((line, index) => index > 0 && line === '---');
  if (endIndex === -1) {
    throw new Error('unterminated frontmatter');
  }

  return lines.slice(1, endIndex).join('\n');
}

function trimBlockIndent(lines: string[]): string {
  const indentedLines = lines.filter(line => line.trim().length > 0);
  const indent =
    indentedLines.length === 0
      ? 0
      : Math.min(...indentedLines.map(line => /^\s*/.exec(line)?.[0].length ?? 0));

  return lines
    .map(line => line.slice(Math.min(indent, line.length)))
    .join('\n')
    .trimEnd();
}

function extractSkillDescription(markdown: string): string {
  const lines = extractFrontmatter(markdown).split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const match = /^description:\s*(.*)$/.exec(lines[i]);
    if (match === null) {
      continue;
    }

    const value = match[1].trim();
    if (value !== '|') {
      return value;
    }

    const blockLines: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].length > 0 && !/^\s/.test(lines[j])) {
        break;
      }
      blockLines.push(lines[j]);
    }
    return trimBlockIndent(blockLines);
  }

  throw new Error('missing description');
}

describe('copyArchonSkill', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'archon-skill-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes every bundled skill file under .claude/skills/archon/', async () => {
    await copyArchonSkill(tempDir);

    const skillRoot = join(tempDir, '.claude', 'skills', 'archon');
    for (const [relativePath, content] of Object.entries(BUNDLED_SKILL_FILES)) {
      const dest = join(skillRoot, relativePath);
      expect(existsSync(dest)).toBe(true);
      expect(readFileSync(dest, 'utf-8')).toBe(content);
    }
  });

  it('writes every bundled skill file under .agents/skills/archon/ (Codex path)', async () => {
    await copyArchonSkill(tempDir);

    const skillRoot = join(tempDir, '.agents', 'skills', 'archon');
    for (const [relativePath, content] of Object.entries(BUNDLED_SKILL_FILES)) {
      const dest = join(skillRoot, relativePath);
      expect(existsSync(dest)).toBe(true);
      expect(readFileSync(dest, 'utf-8')).toBe(content);
    }
  });

  it('writes every bundled manage-run skill file under .agents/skills/manage-run/ (Codex path)', async () => {
    await copyArchonSkill(tempDir);

    const skillRoot = join(tempDir, '.agents', 'skills', 'manage-run');
    for (const [relativePath, content] of Object.entries(BUNDLED_MANAGE_RUN_SKILL_FILES)) {
      const dest = join(skillRoot, relativePath);
      expect(existsSync(dest)).toBe(true);
      expect(readFileSync(dest, 'utf-8')).toBe(content);
    }
  });

  it('overwrites pre-existing skill files with bundled content', async () => {
    const skillRoot = join(tempDir, '.claude', 'skills', 'archon');
    const skillMdPath = join(skillRoot, 'SKILL.md');

    // Pre-seed with stale content; copyArchonSkill must overwrite it.
    await copyArchonSkill(tempDir);
    writeFileSync(skillMdPath, 'STALE');
    expect(readFileSync(skillMdPath, 'utf-8')).toBe('STALE');

    await copyArchonSkill(tempDir);
    expect(readFileSync(skillMdPath, 'utf-8')).toBe(BUNDLED_SKILL_FILES['SKILL.md']);
  });
});

describe('bundled skill metadata', () => {
  it('keeps the archon skill description within the Agent Skills limit', () => {
    const description = extractSkillDescription(BUNDLED_SKILL_FILES['SKILL.md']);

    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(SKILL_DESCRIPTION_MAX_CHARS);
  });

  it('keeps the manage-run skill description within the Agent Skills limit', () => {
    const description = extractSkillDescription(BUNDLED_MANAGE_RUN_SKILL_FILES['SKILL.md']);

    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(SKILL_DESCRIPTION_MAX_CHARS);
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
    expect(existsSync(join(tempDir, '.claude', 'skills', 'archon', 'SKILL.md'))).toBe(true);
    // Also installs into the Codex path
    expect(existsSync(join(tempDir, '.agents', 'skills', 'archon', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(tempDir, '.agents', 'skills', 'manage-run', 'SKILL.md'))).toBe(true);
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
