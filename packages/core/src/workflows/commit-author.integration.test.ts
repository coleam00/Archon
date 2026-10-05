import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await removeTempTree(root);
});

async function logContents(root: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async entry => {
        const path = join(root, entry.name);
        if (entry.isDirectory()) return logContents(path);
        return entry.name.endsWith('.jsonl') ? readFile(path, 'utf8') : '';
      })
    )
  ).join('\n');
}

for (const [mode, connection] of [
  ['cli', 'connected'],
  ['orchestrator', 'connected'],
  ['resource', 'connected'],
  ['adopted', 'connected'],
  ['worktree', 'connected'],
  ['folder', 'connected'],
  ['cli', 'missing'],
  ['cli', 'disabled'],
] as const) {
  test(`${mode}: ${connection} commit author, ambient committer and private logs`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'archon-commit-author-'));
    roots.push(root);
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, 'test-fixtures/commit-author.ts'),
        root,
        mode,
        connection,
      ],
      {
        env: {
          ...process.env,
          ARCHON_HOME: join(root, 'home'),
          DATABASE_URL: '',
          ARCHON_USER_ID: 'author-operator',
          ARCHON_TELEMETRY_DISABLED: '1',
          GITHUB_APP_ID: connection === 'disabled' ? '' : '123',
          TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32),
          GIT_AUTHOR_NAME: '',
          GIT_AUTHOR_EMAIL: '',
          GIT_COMMITTER_NAME: '',
          GIT_COMMITTER_EMAIL: '',
          LOG_LEVEL: 'debug',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exit, stdout + stderr).toBe(0);
    const cwd = (await readFile(join(root, 'working-path'), 'utf8')).trim();
    const git = Bun.spawn(['git', '-C', cwd, 'log', '-1', '--format=%s%n%an%n%ae%n%cn%n%ce'], {
      stdout: 'pipe',
    });
    const commit = (await new Response(git.stdout).text()).trim().split('\n');
    expect(await git.exited).toBe(0);
    expect(commit.shift()).toBe('proof');
    if (mode === 'adopted') expect(cwd).toBe(join(root, 'adopted'));
    if (mode === 'worktree') expect(cwd).not.toBe(join(root, 'project'));
    expect(commit).toEqual(
      connection === 'connected'
        ? [
            'connected-author',
            '42+connected-author@users.noreply.github.com',
            'Ambient Archon',
            'ambient@example.test',
          ]
        : ['Ambient Archon', 'ambient@example.test', 'Ambient Archon', 'ambient@example.test']
    );
    const logs = stdout + stderr + (await logContents(join(root, 'home')));
    expect(logs).not.toContain('connected-author');
    expect(logs).not.toContain('42+connected-author@users.noreply.github.com');
    const config = Bun.spawn(['git', '-C', cwd, 'config', '--local', '--get-regexp', '^user\\.'], {
      stdout: 'pipe',
    });
    expect(await new Response(config.stdout).text()).toBe(
      'user.name Ambient Archon\nuser.email ambient@example.test\n'
    );
    expect(await config.exited).toBe(0);
  }, 30_000);
}
