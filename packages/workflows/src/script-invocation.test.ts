import { expect, test } from 'bun:test';
import { scriptInvocation } from './script-invocation';

test('Bun isolates inline and named scripts from repository env files', () => {
  expect(scriptInvocation('bun', { kind: 'inline', code: 'console.log(1)' }, ['ignored'])).toEqual({
    command: 'bun',
    args: ['--no-env-file', '-e', 'console.log(1)'],
  });
  expect(scriptInvocation('bun', { kind: 'file', path: '/scripts/job.ts' })).toEqual({
    command: 'bun',
    args: ['--no-env-file', 'run', '/scripts/job.ts'],
  });
});

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
