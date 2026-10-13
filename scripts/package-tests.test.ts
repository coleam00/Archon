import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots, testTimeout } from '@archon/paths/test-utils';
import { TEST_ISOLATION_DIRECTIVE } from './package-test-groups';

const track = trackTempRoots();
const runner = join(import.meta.dir, 'package-tests.ts');
function fixture(): string {
  const root = track(mkdtempSync(join(tmpdir(), 'package-runner-')));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({}));
  return root;
}
async function run(root: string, args: string[] = []): Promise<number> {
  const child = Bun.spawn([process.execPath, 'run', runner, ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ARCHON_TELEMETRY_DISABLED: '1' },
  });
  const [status] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return status;
}
function testFile(root: string, name: string, body: string, isolated = false): void {
  writeFileSync(
    join(root, 'src', `${name}.test.ts`),
    `${isolated ? TEST_ISOLATION_DIRECTIVE : ''}\nimport { test, expect, mock } from 'bun:test';\nimport { appendFileSync } from 'node:fs';\n${body}`
  );
}

test(
  'marked module mocks get fresh processes while independent ordinary additions share one',
  async () => {
    const root = fixture();
    writeFileSync(join(root, 'src', 'value.ts'), 'export const value = "real";');
    testFile(
      root,
      'a-mock',
      `mock.module('./value', () => ({ value: 'mock' }));
    const { value } = await import('./value');
    test('mock', () => { expect(value).toBe('mock'); appendFileSync('pids', 'mock:' + process.pid + '\\n'); });`,
      true
    );
    testFile(
      root,
      'b-real',
      `import { value } from './value';
    test('real', () => { expect(value).toBe('real'); appendFileSync('pids', 'real:' + process.pid + '\\n'); });`,
      true
    );
    const manifest = readFileSync(join(root, 'package.json'), 'utf8');
    for (const name of ['one', 'two']) {
      testFile(
        root,
        name,
        `test('${name}', () => appendFileSync('pids', '${name}:' + process.pid + '\\n'));`
      );
    }
    expect(await run(root)).toBe(0);
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(manifest);
    const pids = new Map(
      readFileSync(join(root, 'pids'), 'utf8')
        .trim()
        .split('\n')
        .map(line => {
          const [name, pid] = line.split(':');
          return [name, pid] as const;
        })
    );
    expect([...pids.keys()].sort()).toEqual(['mock', 'one', 'real', 'two']);
    expect(pids.get('one')).toBe(pids.get('two'));
    expect(new Set([pids.get('mock'), pids.get('real'), pids.get('one')]).size).toBe(3);
  },
  testTimeout(5000)
);

test(
  'requested substring selectors and name flags bypass groups verbatim',
  async () => {
    const root = fixture();
    testFile(
      root,
      'logger',
      `test('wanted', () => appendFileSync('selected', 'yes')); test('excluded', () => { throw new Error('not selected'); });`
    );
    testFile(root, 'other', `test('wanted', () => { throw new Error('not selected'); });`);
    // Fails default discovery, so the selected run must not resolve groups.
    testFile(root, 'unmarked', `mock.module('./value', () => ({}));`);
    expect(await run(root, ['logger', '--test-name-pattern', 'wanted'])).toBe(0);
    expect(readFileSync(join(root, 'selected'), 'utf8')).toBe('yes');
    expect(await run(root, ['no-matching-selector'])).not.toBe(0);
  },
  testTimeout(5000)
);

test(
  'failure stops execution before later groups',
  async () => {
    const root = fixture();
    testFile(
      root,
      'a-failure',
      `test('fails', () => { throw new Error('expected failure'); });`,
      true
    );
    testFile(root, 'z-later', `test('later', () => appendFileSync('later', 'ran'));`);
    expect(await run(root, ['src/a-failure.test.ts'])).not.toBe(0);
    expect(await run(root)).not.toBe(0);
    expect(existsSync(join(root, 'later'))).toBe(false);
  },
  testTimeout(5000)
);
