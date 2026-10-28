import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots, testTimeout } from '@archon/paths/test-utils';
import { TEST_ISOLATION_DIRECTIVE } from './package-test-groups';

const track = trackTempRoots();
const runner = join(import.meta.dir, 'package-tests.ts');
function fixture(manifest: object = {}): string {
  const root = track(mkdtempSync(join(tmpdir(), 'package-runner-')));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  return root;
}
async function run(root: string, args: string[] = [], part = ''): Promise<number> {
  const child = Bun.spawn([process.execPath, 'run', runner, ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ARCHON_TELEMETRY_DISABLED: '1', ARCHON_TEST_PART: part },
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

test(
  'testConcurrency runs that many groups at once, each in its own process',
  async () => {
    const root = fixture({ testConcurrency: 2 });
    // Each group waits for the file the other writes, so both pass only side by side.
    const rendezvous = (mine: string, theirs: string): string =>
      `import { existsSync, writeFileSync } from 'node:fs';
    test('meets', async () => {
      writeFileSync('${mine}', String(process.pid));
      const deadline = Date.now() + 4000;
      while (!existsSync('${theirs}') && Date.now() < deadline) await Bun.sleep(25);
      expect(existsSync('${theirs}')).toBe(true);
    }, 5000);`;
    testFile(root, 'a', rendezvous('a-ready', 'b-ready'), true);
    testFile(root, 'b', rendezvous('b-ready', 'a-ready'), true);
    expect(await run(root)).toBe(0);
    expect(readFileSync(join(root, 'a-ready'), 'utf8')).not.toBe(
      readFileSync(join(root, 'b-ready'), 'utf8')
    );
  },
  testTimeout(10000)
);

test(
  'a failing group fails a concurrent run',
  async () => {
    const root = fixture({ testConcurrency: 2 });
    testFile(root, 'a-failure', `test('fails', () => { throw new Error('expected'); });`, true);
    testFile(root, 'b-pass', `test('passes', () => {});`, true);
    expect(await run(root)).not.toBe(0);
  },
  testTimeout(5000)
);

test(
  'ARCHON_TEST_PART runs disjoint parts that together run every group',
  async () => {
    const root = fixture();
    for (const name of ['a', 'b', 'c']) {
      testFile(root, name, `test('${name}', () => appendFileSync('ran', '${name}\\n'));`, true);
    }
    const ran = (): string[] =>
      existsSync(join(root, 'ran'))
        ? readFileSync(join(root, 'ran'), 'utf8').trim().split('\n')
        : [];
    expect(await run(root, [], '1/2')).toBe(0);
    const first = ran();
    expect(await run(root, [], '2/2')).toBe(0);
    const second = ran().slice(first.length);
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
    expect([...first, ...second].sort()).toEqual(['a', 'b', 'c']);
    expect(await run(root, [], '3/2')).not.toBe(0);
  },
  testTimeout(10000)
);
