import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { scriptInvocation } from './script-invocation';

const track = trackTempRoots();
const artifacts = (): string => track(mkdtempSync(join(tmpdir(), 'archon-script-invocation-')));

test('Bun inline stdin preserves source exactly', () => {
  const code =
    'const message: string = `€ 雪 🦉\r\nsecond line  \t\r\n`;\r\nconsole.log(message);\r\n \t';
  expect(scriptInvocation('bun', { kind: 'inline', code }, [], artifacts()).input).toBe(code);
});

test('Bun isolates inline and named scripts from repository env files', () => {
  const artifactsDir = artifacts();
  const inline = scriptInvocation(
    'bun',
    { kind: 'inline', code: 'console.log(1)' },
    ['ignored'],
    artifactsDir
  );
  expect(inline.args).toEqual(['--no-env-file', expect.stringMatching(/^--preload=/), '-']);
  expect(inline.input).toBe('console.log(1)');
  const preload = inline.args[1].slice('--preload='.length);
  expect(existsSync(preload)).toBe(true);
  expect(
    scriptInvocation('bun', { kind: 'file', path: '/scripts/job.ts' }, [], artifactsDir)
  ).toEqual({
    command: 'bun',
    args: ['--no-env-file', 'run', `--preload=${preload}`, '/scripts/job.ts'],
  });
});

test('uv places dependencies before inline Python or a named script', () => {
  const artifactsDir = artifacts();
  const inline = scriptInvocation(
    'uv',
    { kind: 'inline', code: 'print(1)' },
    ['httpx', 'rich'],
    artifactsDir
  ).args;
  expect(inline.slice(-7)).toEqual([
    '--with',
    'httpx',
    '--with',
    'rich',
    'python',
    '-c',
    'print(1)',
  ]);
  const named = scriptInvocation(
    'uv',
    { kind: 'file', path: '/scripts/job.py' },
    ['httpx'],
    artifactsDir
  ).args;
  expect(named.slice(-3)).toEqual(['--with', 'httpx', '/scripts/job.py']);
});
