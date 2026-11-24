/**
 * Tests for bundled skill copying and CLI commands
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { removeTempTree, trackTempRoots } from '@archon/paths/test-utils';
import { pluginReceiptSchema } from '@archon/plugin-manifest';
import { packTreePath, receiptPath } from '@archon/plugin-manifest/store';
import { BUNDLED_SKILL_FILES } from '../bundled-skill';
import { copyArchonSkill, packSkillInstallCommand, skillInstallCommand } from './skill';

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

describe('packSkillInstallCommand', () => {
  const tempRoot = trackTempRoots();
  const ID = 'owner/review-kit';
  const COMMIT = 'a'.repeat(40);

  /** An installed workflow pack: its receipt and its tree, with the tree's own manifest. */
  function installPack(
    pluginsDir: string,
    id: string,
    skill: { name: string; path: string } | undefined,
    files: Record<string, string> = {}
  ): string {
    const manifest = {
      schemaVersion: 1,
      kind: 'workflow-pack',
      name: id.split('/')[1],
      description: 'fixture',
      entrypoints: { review: 'review/review.yaml' },
      ...(skill ? { skill } : {}),
    };
    const receipt = pluginReceiptSchema.parse({
      schemaVersion: 1,
      id,
      manifest,
      commit: COMMIT,
      installedAt: new Date().toISOString(),
    });
    mkdirSync(join(receiptPath(pluginsDir, id), '..'), { recursive: true });
    writeFileSync(receiptPath(pluginsDir, id), JSON.stringify(receipt));
    const tree = packTreePath(pluginsDir, id, COMMIT);
    for (const [path, content] of Object.entries({
      'archon-plugin.json': JSON.stringify(manifest),
      ...files,
    })) {
      mkdirSync(join(tree, path, '..'), { recursive: true });
      writeFileSync(join(tree, path), content);
    }
    return tree;
  }

  async function run(
    id: string,
    target: string,
    pluginsDir: string
  ): Promise<{ code: number; out: string; err: string }> {
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const code = await packSkillInstallCommand(id, target, pluginsDir);
      return {
        code,
        out: log.mock.calls.map(call => call.join(' ')).join('\n'),
        err: error.mock.calls.map(call => call.join(' ')).join('\n'),
      };
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  }

  function setup(): { pluginsDir: string; project: string } {
    const root = tempRoot(mkdtempSync(join(tmpdir(), 'archon-pack-skill-')));
    const project = join(root, 'project');
    mkdirSync(project);
    return { pluginsDir: join(root, 'plugins'), project };
  }

  it('copies the skill folder into both roots, and a rerun replaces it whole', async () => {
    const { pluginsDir, project } = setup();
    const tree = installPack(
      pluginsDir,
      ID,
      { name: 'review-kit', path: 'skills/review-kit' },
      {
        'skills/review-kit/SKILL.md': '# Review kit v1\n',
        'skills/review-kit/reference/queues.md': 'queues\n',
        'skills/review-kit/reference/old.md': 'dropped next release\n',
      }
    );
    for (const root of ['.claude', '.agents']) {
      const archonCli = join(project, root, 'skills', 'archon-cli');
      mkdirSync(archonCli, { recursive: true });
      writeFileSync(join(archonCli, 'SKILL.md'), 'Archon skill');
    }

    const first = await run(ID, project, pluginsDir);
    expect(first.err).toBe('');
    expect(first.code).toBe(0);
    for (const root of ['.claude', '.agents']) {
      const skill = join(project, root, 'skills', 'review-kit');
      expect(readFileSync(join(skill, 'SKILL.md'), 'utf8')).toBe('# Review kit v1\n');
      expect(readFileSync(join(skill, 'reference/queues.md'), 'utf8')).toBe('queues\n');
    }

    // A pack update: one file changes, one is gone.
    writeFileSync(join(tree, 'skills/review-kit/SKILL.md'), '# Review kit v2\n');
    rmSync(join(tree, 'skills/review-kit/reference/old.md'));
    expect((await run(ID, project, pluginsDir)).code).toBe(0);
    for (const root of ['.claude', '.agents']) {
      const skill = join(project, root, 'skills', 'review-kit');
      expect(readFileSync(join(skill, 'SKILL.md'), 'utf8')).toBe('# Review kit v2\n');
      expect(existsSync(join(skill, 'reference/old.md'))).toBe(false);
      expect(readFileSync(join(project, root, 'skills/archon-cli/SKILL.md'), 'utf8')).toBe(
        'Archon skill'
      );
    }
  });

  it('reads the skill from the installed tree when the receipt predates the field', async () => {
    const { pluginsDir, project } = setup();
    installPack(pluginsDir, ID, { name: 'review-kit', path: 'skill' }, { 'skill/SKILL.md': 'x' });
    // An older Archon wrote this receipt and stripped the key it did not know.
    const file = receiptPath(pluginsDir, ID);
    const receipt = JSON.parse(readFileSync(file, 'utf8'));
    delete receipt.manifest.skill;
    writeFileSync(file, JSON.stringify(receipt));

    expect((await run(ID, project, pluginsDir)).code).toBe(0);
    expect(readFileSync(join(project, '.agents/skills/review-kit/SKILL.md'), 'utf8')).toBe('x');
  });

  it('refuses a pack that is not installed or ships no skill, naming it and writing nothing', async () => {
    const { pluginsDir, project } = setup();
    const missing = await run(ID, project, pluginsDir);
    expect(missing.code).toBe(1);
    expect(missing.err).toBe(`Error: ${ID} is not installed. Install it: archon plugin add ${ID}`);

    installPack(pluginsDir, ID, undefined);
    const none = await run(ID, project, pluginsDir);
    expect(none.code).toBe(1);
    expect(none.err).toBe(
      `Error: ${ID} ships no skill (its archon-plugin.json declares no "skill")`
    );
    expect(existsSync(join(project, '.claude'))).toBe(false);
    expect(existsSync(join(project, '.agents'))).toBe(false);
  });

  it('refuses a skill name another installed pack ships, naming both packs', async () => {
    const { pluginsDir, project } = setup();
    const skill = { name: 'review-kit', path: 'skill' };
    installPack(pluginsDir, ID, skill, { 'skill/SKILL.md': 'mine' });
    installPack(pluginsDir, 'other/review-kit', skill, { 'skill/SKILL.md': 'theirs' });

    const result = await run(ID, project, pluginsDir);
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      `Error: ${ID} and other/review-kit both ship a skill named review-kit; installing it would replace the other pack's skill`
    );
    expect(existsSync(join(project, '.claude'))).toBe(false);
  });

  // Receipts know only what is installed now; the project folder keeps its owner.
  it('refuses a folder another pack installed, after that pack is removed or renames its skill', async () => {
    const shared = { name: 'shared-skill', path: 'skill' };
    for (const change of ['removed', 'renamed'] as const) {
      const { pluginsDir, project } = setup();
      const alpha = installPack(pluginsDir, 'alpha/first', shared, { 'skill/SKILL.md': 'alpha' });
      expect((await run('alpha/first', project, pluginsDir)).code).toBe(0);
      if (change === 'removed') {
        rmSync(join(receiptPath(pluginsDir, 'alpha/first'), '..'), { recursive: true });
        rmSync(alpha, { recursive: true });
      } else {
        installPack(
          pluginsDir,
          'alpha/first',
          { name: 'renamed-skill', path: 'skill' },
          { 'skill/SKILL.md': 'alpha' }
        );
      }
      installPack(pluginsDir, 'beta/second', shared, { 'skill/SKILL.md': 'beta' });

      const result = await run('beta/second', project, pluginsDir);
      expect(result.code).toBe(1);
      expect(result.err).toContain('holds the skill alpha/first installed, not beta/second');
      for (const root of ['.claude', '.agents']) {
        expect(readFileSync(join(project, root, 'skills/shared-skill/SKILL.md'), 'utf8')).toBe(
          'alpha'
        );
      }
    }
  });

  it('refuses a same-named folder no pack install wrote, leaving it as it is', async () => {
    const { pluginsDir, project } = setup();
    installPack(pluginsDir, ID, { name: 'review-kit', path: 'skill' }, { 'skill/SKILL.md': 'x' });
    const handCopy = join(project, '.agents', 'skills', 'review-kit');
    mkdirSync(handCopy, { recursive: true });
    writeFileSync(join(handCopy, 'SKILL.md'), 'my own');

    const result = await run(ID, project, pluginsDir);
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      `Error: ${handCopy} exists and archon skill add --pack did not install it; move or delete it, then run this again`
    );
    expect(readFileSync(join(handCopy, 'SKILL.md'), 'utf8')).toBe('my own');
    expect(existsSync(join(project, '.claude', 'skills', 'review-kit'))).toBe(false);
  });

  it('is what archon skill add --pack runs, and never writes archon-cli', async () => {
    const root = tempRoot(mkdtempSync(join(tmpdir(), 'archon-pack-skill-cli-')));
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, '../cli.ts'), 'skill', 'add', '--pack', ID, root],
      {
        cwd: root,
        env: { ...process.env, ARCHON_TELEMETRY_DISABLED: '1', ARCHON_HOME: root },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(1);
    expect(err).toContain(`${ID} is not installed`);
    expect(existsSync(join(root, '.claude'))).toBe(false);
  });
});
