/**
 * Tests for bundled skill copying and CLI commands
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
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

  it('bundles every file under the shipped skill root', () => {
    const files = [
      ...new Bun.Glob('**/*').scanSync({
        cwd: resolve(import.meta.dir, '../../../../.claude/skills/archon-cli'),
        onlyFiles: true,
        dot: true,
      }),
    ]
      .map(file => file.replaceAll('\\', '/'))
      .sort();
    expect(Object.keys(BUNDLED_SKILL_FILES).sort()).toEqual(files);
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
    const content = BUNDLED_SKILL_FILES['operate/managing-runs.md'];
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

  it('removes extra files from both owned skill roots without touching sibling skills', async () => {
    for (const root of ['.claude', '.agents']) {
      const skillsRoot = join(tempDir, root, 'skills');
      const skillRoot = join(skillsRoot, 'archon-cli');
      mkdirSync(skillRoot, { recursive: true });
      writeFileSync(join(skillRoot, 'retired.md'), 'retired guidance');
      mkdirSync(join(skillsRoot, 'user-skill'), { recursive: true });
      writeFileSync(join(skillsRoot, 'user-skill', 'SKILL.md'), 'user guidance');
    }

    await copyArchonSkill(tempDir);

    for (const root of ['.claude', '.agents']) {
      const skillsRoot = join(tempDir, root, 'skills');
      expect(existsSync(join(skillsRoot, 'archon-cli', 'retired.md'))).toBe(false);
      expect(readFileSync(join(skillsRoot, 'user-skill', 'SKILL.md'), 'utf-8')).toBe(
        'user guidance'
      );
    }
  });

  it('replaces an archon-cli symlink without deleting its target', async () => {
    const external = join(tempDir, 'external-skill');
    mkdirSync(external);
    writeFileSync(join(external, 'user.md'), 'keep me');

    for (const root of ['.claude', '.agents']) {
      const skillsRoot = join(tempDir, root, 'skills');
      mkdirSync(skillsRoot, { recursive: true });
      symlinkSync(external, join(skillsRoot, 'archon-cli'), 'dir');
    }

    await copyArchonSkill(tempDir);

    expect(readFileSync(join(external, 'user.md'), 'utf-8')).toBe('keep me');
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

describe('skill CLI verbs', () => {
  for (const verb of ['add', 'install']) {
    it(`${verb} rejects extra paths without replacing existing skill files`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'archon-skill-cli-arity-'));
      const target = join(root, 'target');
      const extra = join(root, 'extra');
      try {
        for (const destination of ['.claude', '.agents']) {
          const skillRoot = join(target, destination, 'skills', 'archon-cli');
          mkdirSync(skillRoot, { recursive: true });
          writeFileSync(join(skillRoot, 'SKILL.md'), 'User-owned skill content');
          writeFileSync(join(skillRoot, 'custom.md'), 'Keep this file');
        }
        const child = Bun.spawn(
          [process.execPath, join(import.meta.dir, '../cli.ts'), 'skill', verb, target, extra],
          {
            cwd: root,
            env: { ...process.env, ARCHON_TELEMETRY_DISABLED: '1', ARCHON_HOME: root },
            stdout: 'pipe',
            stderr: 'pipe',
          }
        );
        const [out, err, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(code).toBe(1);
        expect(err.trim()).toBe('Usage: archon skill add [path]');
        expect(out).toBe('');
        for (const destination of ['.claude', '.agents']) {
          const skillRoot = join(target, destination, 'skills', 'archon-cli');
          expect(readFileSync(join(skillRoot, 'SKILL.md'), 'utf8')).toBe(
            'User-owned skill content'
          );
          expect(readFileSync(join(skillRoot, 'custom.md'), 'utf8')).toBe('Keep this file');
        }
        expect(existsSync(extra)).toBe(false);
      } finally {
        await removeTempTree(root);
      }
    });
  }

  it('rejects an unknown verb without replacing existing skill files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'archon-skill-cli-reject-'));
    try {
      for (const destination of ['.claude', '.agents']) {
        const skillRoot = join(root, destination, 'skills', 'archon-cli');
        mkdirSync(skillRoot, { recursive: true });
        writeFileSync(join(skillRoot, 'SKILL.md'), 'User-owned skill content');
      }
      const child = Bun.spawn(
        [process.execPath, join(import.meta.dir, '../cli.ts'), 'skill', 'bogus', root],
        {
          cwd: root,
          env: { ...process.env, ARCHON_TELEMETRY_DISABLED: '1', ARCHON_HOME: root },
          stdout: 'pipe',
          stderr: 'pipe',
        }
      );
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(1);
      expect(err).toContain('Unknown skill subcommand: bogus');
      expect(err.split('\n')).toContain('Available: add');
      expect(out).not.toContain('Adding Archon skill');
      for (const destination of ['.claude', '.agents']) {
        expect(readFileSync(join(root, destination, 'skills/archon-cli/SKILL.md'), 'utf8')).toBe(
          'User-owned skill content'
        );
      }
    } finally {
      await removeTempTree(root);
    }
  });

  it('add and the deprecated alias write the bundled files, with one alias warning', async () => {
    const root = mkdtempSync(join(tmpdir(), 'archon-skill-cli-'));
    try {
      for (const [verb, explicitPath] of [
        ['add', false],
        ['install', true],
      ] as const) {
        const target = join(root, verb);
        mkdirSync(target);
        const child = Bun.spawn(
          [
            process.execPath,
            join(import.meta.dir, '../cli.ts'),
            'skill',
            verb,
            ...(explicitPath ? [target] : []),
          ],
          {
            cwd: explicitPath ? root : target,
            env: { ...process.env, ARCHON_TELEMETRY_DISABLED: '1', ARCHON_HOME: root },
            stdout: 'pipe',
            stderr: 'pipe',
          }
        );
        const [out, err, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(code).toBe(0);
        expect(out).toContain('Restart Claude Code or Codex');
        const warning =
          'Warning: archon skill install is deprecated. Use archon skill add instead.';
        expect(err.split(warning).length - 1).toBe(verb === 'install' ? 1 : 0);
        for (const destination of ['.claude', '.agents']) {
          for (const [file, content] of Object.entries(BUNDLED_SKILL_FILES)) {
            expect(readFileSync(join(target, destination, 'skills/archon-cli', file), 'utf8')).toBe(
              content
            );
          }
        }
      }
    } finally {
      await removeTempTree(root);
    }
  });
});
