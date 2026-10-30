import { expect, test } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots, testTimeout } from '@archon/paths/test-utils';
import { TEST_ISOLATION_DIRECTIVE } from './package-test-groups';
import { resolveRequestedTestGroups } from './package-test-requests';

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
  'requested substring selectors and name flags select only matching tests',
  async () => {
    const root = fixture();
    testFile(
      root,
      'logger',
      `test('wanted', () => appendFileSync('selected', 'yes')); test('excluded', () => { throw new Error('not selected'); });`
    );
    testFile(root, 'other', `test('wanted', () => { throw new Error('not selected'); });`);
    expect(await run(root, ['logger', '--test-name-pattern', 'wanted'])).toBe(0);
    expect(readFileSync(join(root, 'selected'), 'utf8')).toBe('yes');
    expect(await run(root, ['no-matching-selector'])).not.toBe(0);
    expect(await run(root, ['no-matching-selector', '--pass-with-no-tests'])).toBe(0);
  },
  testTimeout(5000)
);

for (const declaration of [
  {},
  { testGroups: [['src/a-mock.test.ts'], ['src/b-real.test.ts', 'src/other.test.ts']] },
]) {
  test(
    `requested files preserve isolation: ${JSON.stringify(declaration)}`,
    async () => {
      const root = fixture(declaration);
      writeFileSync(join(root, 'src', 'value.ts'), 'export const value = "real";');
      testFile(
        root,
        'a-mock',
        `mock.module('./value', () => ({ value: 'mock' }));
        test('wanted', async () => {
          expect((await import('./value')).value).toBe('mock');
          appendFileSync('pids', String(process.pid) + '\\n');
        });`,
        true
      );
      testFile(
        root,
        'b-real',
        `import { value } from './value';
        test('wanted', () => {
          expect(value).toBe('real');
          appendFileSync('pids', String(process.pid) + '\\n');
        });`,
        true
      );
      testFile(root, 'other', `test('wanted', () => { throw new Error('not requested'); });`);
      expect(await run(root, ['a-mock', 'b-real', '-t', 'wanted'])).toBe(0);
      const pids = readFileSync(join(root, 'pids'), 'utf8').trim().split('\n');
      expect(pids).toHaveLength(2);
      expect(new Set(pids).size).toBe(2);
    },
    testTimeout(5000)
  );
}

test(
  'requested directory and overlapping selectors preserve shared groups and option values',
  async () => {
    const root = fixture({ testGroups: [['src/']] });
    for (const name of ['one', 'two']) {
      testFile(
        root,
        name,
        `test('two', () => appendFileSync('pids', String(process.pid) + '\\n'));
         test('excluded', () => { throw new Error('not selected'); });`
      );
    }
    expect(
      await run(root, [
        'src/',
        'one',
        '--test-name-pattern',
        'two',
        '--timeout',
        '1000',
        '--bail',
        '2',
      ])
    ).toBe(0);
    const pids = readFileSync(join(root, 'pids'), 'utf8').trim().split('\n');
    expect(pids).toHaveLength(2);
    expect(new Set(pids).size).toBe(1);
  },
  testTimeout(5000)
);

test('optional inline flags leave the following file selector intact', () => {
  const root = fixture();
  testFile(root, 'one', `test('one', () => {});`, true);
  testFile(root, 'two', `test('two', () => {});`, true);
  for (const option of ['--changed=HEAD', '--parallel=2', '--bail=1']) {
    expect(resolveRequestedTestGroups(root, {}, [option, 'one']).groups).toEqual([
      [option, './src/one.test.ts'],
    ]);
  }
  expect(resolveRequestedTestGroups(root, {}, ['one', '-t', 'two']).groups).toEqual([
    ['-t', 'two', './src/one.test.ts'],
  ]);
});

test(
  'name filters may match one isolation group, while real failures and zero matches stay red',
  async () => {
    const root = fixture({ testConcurrency: 2 });
    testFile(root, 'a', `test('other', () => { throw new Error('not selected'); });`, true);
    testFile(root, 'b', `test('wanted', () => appendFileSync('selected', 'yes'));`, true);
    const args = ['src/', '-t', 'wanted'];
    expect(await run(root, args)).toBe(0);
    expect(readFileSync(join(root, 'selected'), 'utf8')).toBe('yes');
    const report = join(root, 'requested-report.xml');
    expect(await run(root, [...args, '--reporter=junit', '--reporter-outfile', report])).toBe(0);
    const xml = readFileSync(report, 'utf8');
    expect(xml).toContain('name="other"');
    expect(xml).toContain('name="wanted"');
    expect(xml).toMatch(/<testsuites[^>]*skipped="1"/);

    expect(await run(root, ['src/', '-t', 'absent'])).not.toBe(0);
    expect(await run(root, ['src/', '-t', 'absent', '--pass-with-no-tests'])).toBe(0);
    testFile(root, 'a', `test('wanted', () => { throw new Error('real failure'); });`, true);
    expect(await run(root, args)).not.toBe(0);
    testFile(root, 'a', `test('other', () => {}); throw new Error('load failure');`, true);
    expect(await run(root, args)).not.toBe(0);
    testFile(
      root,
      'a',
      `import { beforeAll } from 'bun:test';
      beforeAll(() => { throw new Error('hook failure'); }); test('wanted', () => {});`,
      true
    );
    expect(await run(root, args)).not.toBe(0);
    testFile(
      root,
      'a',
      `import { afterAll } from 'bun:test';
      afterAll(() => { throw new Error('cleanup failure'); }); test('wanted', () => {});`,
      true
    );
    expect(await run(root, args)).not.toBe(0);
  },
  testTimeout(5000)
);

test(
  'requested failures run later groups while full runs stop early',
  async () => {
    const root = fixture();
    testFile(
      root,
      'a-failure',
      `test('fails', () => { throw new Error('expected failure'); });`,
      true
    );
    testFile(root, 'z-later', `test('later', () => appendFileSync('later', 'ran'));`);
    expect(await run(root, ['src/a-failure.test.ts', 'src/z-later.test.ts'])).not.toBe(0);
    expect(readFileSync(join(root, 'later'), 'utf8')).toBe('ran');
    unlinkSync(join(root, 'later'));
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

for (const concurrency of [1, 2]) {
  for (const nameFilter of [false, true]) {
    test(
      `requested JUnit combines every group: concurrency=${concurrency}, filter=${nameFilter}`,
      async () => {
        const root = fixture({ testConcurrency: concurrency });
        testFile(root, 'a', `test('first', () => { throw new Error('expected'); });`, true);
        testFile(root, 'b', `test('second', () => {});`, true);
        testFile(root, 'c', `test('third', () => appendFileSync('third', 'ran'));`, true);
        const report = join(root, 'report.xml');
        expect(
          await run(root, [
            'src/',
            '--reporter=junit',
            '--reporter-outfile',
            report,
            ...(nameFilter ? ['-t', 'first|second|third'] : []),
          ])
        ).not.toBe(0);
        const xml = readFileSync(report, 'utf8');
        for (const name of ['first', 'second', 'third']) expect(xml).toContain(`name="${name}"`);
        expect(xml).toMatch(/<testsuites[^>]*tests="4"/);
        expect(xml).toMatch(/<testsuites[^>]*failures="1"/);
        expect(readFileSync(join(root, 'third'), 'utf8')).toBe('ran');
      },
      testTimeout(5000)
    );
  }
}

for (const failure of [
  `throw new Error('top level');`,
  `import './missing-module';`,
  `const broken = ;`,
]) {
  test(
    `shared load failures stay red under name filters: ${failure}`,
    async () => {
      const root = fixture();
      testFile(root, 'a-skip', `test('other', () => {});`);
      testFile(root, 'b-broken', failure);
      testFile(root, 'c-match', `test('wanted', () => {});`, true);
      const report = join(root, 'load-failure.xml');
      expect(
        await run(root, ['src/', '-t', 'wanted', '--reporter=junit', '--reporter-outfile', report])
      ).not.toBe(0);
      const xml = readFileSync(report, 'utf8');
      expect(xml).toContain('name="other"');
      expect(xml).toContain('name="wanted"');
      expect(xml).toMatch(/<testsuites[^>]*errors="1"/);
    },
    testTimeout(5000)
  );
}

for (const alias of ['src/b.test.ts', 'src/../src/b.test.ts', './src//b.test.ts', 'absolute']) {
  test(
    `relative aliases retain isolation: ${alias}`,
    async () => {
      const root = fixture();
      for (const name of ['a', 'b'])
        testFile(
          root,
          name,
          `test('${name}', () => appendFileSync('pids', process.pid + '\\n'));`,
          true
        );
      expect(
        await run(root, [
          'src/a.test.ts',
          alias === 'absolute' ? join(realpathSync(root), 'src/b.test.ts') : alias,
        ])
      ).toBe(0);
      const pids = readFileSync(join(root, 'pids'), 'utf8').trim().split('\n');
      expect(pids).toHaveLength(2);
      expect(new Set(pids).size).toBe(2);
    },
    testTimeout(5000)
  );
}

test(
  'requested discovery validates only selected tests',
  async () => {
    const root = fixture();
    testFile(root, 'a', `test('wanted', () => appendFileSync('selected', 'yes'));`);
    testFile(root, 'invalid', `mock.module('./value', () => ({}));`);
    expect(await run(root, ['src/a.test.ts'])).toBe(0);
    expect(readFileSync(join(root, 'selected'), 'utf8')).toBe('yes');
    expect(await run(root, ['src/invalid.test.ts'])).not.toBe(0);
    testFile(
      root,
      'z-isolated',
      `test('isolated', () => appendFileSync('isolated', 'yes'));`,
      true
    );
    unlinkSync(join(root, 'selected'));
    expect(await run(root, ['src/'])).not.toBe(0);
    expect(readFileSync(join(root, 'selected'), 'utf8')).toBe('yes');
    expect(readFileSync(join(root, 'isolated'), 'utf8')).toBe('yes');
    expect(await run(root)).not.toBe(0);
  },
  testTimeout(5000)
);

for (const omission of ['ignored', 'sharded', 'changed', 'unmatched', 'module', 'describe']) {
  test(
    `name filters allow legitimate missing suites: ${omission}`,
    async () => {
      const root = fixture();
      testFile(root, 'a-empty', `test('other', () => {});`);
      testFile(root, 'b-empty', `test('other', () => {});`);
      testFile(root, 'c-match', `test('wanted', () => appendFileSync('matched', 'yes'));`, true);
      const options: string[] = [];
      if (omission === 'ignored') options.push('--path-ignore-patterns', '**/*empty*');
      if (omission === 'sharded') options.push('--shard', '1/2');
      if (omission === 'unmatched') options.push('no-such-substring');
      if (omission === 'module') testFile(root, 'a-empty', `export const value = 1;`);
      if (omission === 'describe')
        testFile(
          root,
          'a-empty',
          `import { describe } from 'bun:test'; describe('empty', () => {});`
        );
      if (omission === 'changed') {
        for (const args of [
          ['init'],
          ['add', '.'],
          [
            '-c',
            'user.name=Runner',
            '-c',
            'user.email=runner@example.com',
            'commit',
            '-m',
            'fixture',
          ],
        ]) {
          expect(Bun.spawnSync(['git', ...args], { cwd: root }).exitCode).toBe(0);
        }
        testFile(
          root,
          'c-match',
          `test('wanted', () => appendFileSync('matched', 'changed'));`,
          true
        );
        testFile(root, 'b-empty', `test('other changed', () => {});`);
        options.push('--changed=HEAD');
      }
      const report = join(root, 'omission.xml');
      expect(
        await run(root, [
          'src/',
          '-t',
          'wanted',
          ...options,
          '--reporter=junit',
          '--reporter-outfile',
          report,
        ])
      ).toBe(0);
      expect(existsSync(join(root, 'matched'))).toBe(true);
      expect(readFileSync(report, 'utf8')).toMatch(/<testsuites[^>]*errors="0"/);
    },
    testTimeout(5000)
  );
}

test(
  'mixed assertion and load failures retain the failed process in JUnit',
  async () => {
    const root = fixture();
    testFile(root, 'a-fail', `test('assertion', () => expect(1).toBe(2));`);
    testFile(root, 'b-load', `import './missing';`);
    testFile(root, 'c-pass', `test('pass', () => {});`, true);
    const report = join(root, 'mixed.xml');
    expect(await run(root, ['src/', '--reporter=junit', '--reporter-outfile', report])).not.toBe(0);
    const xml = readFileSync(report, 'utf8');
    expect(xml).toContain('name="assertion"');
    expect(xml).toContain('name="pass"');
    expect(xml).toMatch(/<testsuites[^>]*failures="1"/);
    expect(xml).toMatch(/<testsuites[^>]*errors="1"/);
    expect(xml).toContain('see child output for diagnostics');
  },
  testTimeout(5000)
);
