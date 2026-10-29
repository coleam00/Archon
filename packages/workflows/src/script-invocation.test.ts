import { expect, test } from 'bun:test';
import { removeTempTree } from '@archon/paths/test-utils';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptInvocation } from './script-invocation';

test('Bun isolates inline and named scripts from repository env files', () => {
  expect(scriptInvocation('bun', { kind: 'inline', code: 'console.log(1)' }, ['ignored'])).toEqual({
    command: 'bun',
    args: ['--no-env-file', '-'],
    input: 'console.log(1)',
  });
  expect(scriptInvocation('bun', { kind: 'file', path: '/scripts/job.ts' })).toEqual({
    command: 'bun',
    args: ['--no-env-file', 'run', '/scripts/job.ts'],
  });
});

test.skipIf(process.platform !== 'win32')(
  'Bun receives multiline inline source intact through a Windows cmd shim',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'archon-bun-cmd-'));
    try {
      const shim = join(dir, 'bun.cmd');
      await writeFile(shim, `@"${process.execPath}" %*\r\n`);
      const code = `const first = "first line";\nconsole.log(first + " and second line");`;
      const invocation = scriptInvocation('bun', { kind: 'inline', code });

      const result = spawnSync(shim, invocation.args, {
        input: invocation.input,
        encoding: 'utf8',
        windowsHide: true,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout.trim()).toBe('first line and second line');
    } finally {
      await removeTempTree(dir);
    }
  }
);

test('uv places dependencies before inline Python or a named script', () => {
  expect(scriptInvocation('uv', { kind: 'inline', code: 'print(1)' }, ['httpx', 'rich'])).toEqual({
    command: 'uv',
    args: ['run', '--with', 'httpx', '--with', 'rich', 'python', '-c', 'print(1)'],
  });
  expect(scriptInvocation('uv', { kind: 'file', path: '/scripts/job.py' }, ['httpx'])).toEqual({
    command: 'uv',
    args: ['run', '--with', 'httpx', '/scripts/job.py'],
  });
  expect(scriptInvocation('uv', { kind: 'file', path: '/scripts/job.py' }).args).toEqual([
    'run',
    '/scripts/job.py',
  ]);
});
