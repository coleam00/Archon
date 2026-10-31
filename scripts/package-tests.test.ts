import { expect, test } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
  realpathSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots, testTimeout } from '@archon/paths/test-utils';
import { TEST_ISOLATION_DIRECTIVE } from './package-test-groups';
import {
  junitDestination,
  parseTestArguments,
  resolveRequestedTestGroups,
} from './package-test-requests';
import { bunTestCommand, bunTestEnv } from './bun-test-command';

const track = trackTempRoots();
const runner = join(import.meta.dir, 'package-tests.ts');
function fixture(manifest: object = {}): string {
  const root = track(mkdtempSync(join(tmpdir(), 'package-runner-')));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  return root;
}
async function native(root: string, args: string[]): Promise<number> {
  const child = Bun.spawn(bunTestCommand(args), {
    cwd: root,
    env: bunTestEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return code;
}
async function runResult(root: string, args: string[] = [], part = '') {
  const child = Bun.spawn([process.execPath, 'run', runner, ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ARCHON_TELEMETRY_DISABLED: '1', ARCHON_TEST_PART: part },
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status, stdout, stderr };
}
async function run(root: string, args: string[] = [], part = ''): Promise<number> {
  return (await runResult(root, args, part)).status;
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
      expect(await run(root, ['a-mock', 'b-real'])).toBe(0);
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

test('optional flags leave the following file selector intact', () => {
  const root = fixture();
  testFile(root, 'one', `test('one', () => {});`, true);
  testFile(root, 'two', `test('two', () => {});`, true);
  for (const option of ['--changed', '--changed=HEAD', '--parallel=2', '--bail=1']) {
    expect(resolveRequestedTestGroups(root, {}, [option, 'one']).groups).toEqual([
      [option, './src/one.test.ts'],
    ]);
  }
  expect(resolveRequestedTestGroups(root, {}, ['one', '-t', 'two']).groups).toEqual([
    ['-t', 'two', './src/one.test.ts'],
  ]);
});

for (const concurrency of [1, 2]) {
  for (const declaration of [{}, { testGroups: [['src/a.test.ts'], ['src/b.test.ts']] }]) {
    test(
      `cross-group name filters fail before loading tests: ${JSON.stringify(declaration)}, concurrency=${concurrency}`,
      async () => {
        const root = fixture({ ...declaration, testConcurrency: concurrency });
        for (const name of ['a', 'b']) {
          testFile(root, name, `appendFileSync('loaded', 'yes'); test('wanted', () => {});`, true);
        }
        const report = join(root, 'rejected.xml');
        for (const args of [
          ['a.test', 'b.test', '-t', 'wanted'],
          ['src/', '--test-name-pattern', 'wanted'],
          ['src/', '--test-name-pattern=wanted'],
          ['src/', '-twanted'],
          ['-t', ''],
          [
            'src/',
            '-t',
            'absent',
            '--pass-with-no-tests',
            '--reporter=junit',
            '--reporter-outfile',
            report,
          ],
        ]) {
          const result = await runResult(root, args);
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain('Name filters require one isolation group');
          for (const name of ['a', 'b']) expect(result.stderr).toContain(`./src/${name}.test.ts`);
          expect(existsSync(join(root, 'loaded'))).toBe(false);
          expect(existsSync(report)).toBe(false);
        }
      },
      testTimeout(5000)
    );
  }
}

for (const concurrency of [1, 2]) {
  for (const declaration of [{}, { testGroups: [['src/a.test.ts'], ['src/b.test.ts']] }]) {
    test(
      `cross-group sharding fails before loading tests: ${JSON.stringify(declaration)}, concurrency=${concurrency}`,
      async () => {
        const root = fixture({ ...declaration, testConcurrency: concurrency });
        for (const name of ['a', 'b']) {
          testFile(root, name, `appendFileSync('loaded', 'yes'); test('wanted', () => {});`, true);
        }
        for (const args of [
          ['src/', '--shard=2/2'],
          ['src/', '--shard', '2/2'],
          ['--shard=2/2'],
          [
            'src/',
            '--shard=2/2',
            '--reporter=junit',
            '--reporter-outfile',
            join(root, 'rejected.xml'),
          ],
        ]) {
          const result = await runResult(root, args);
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain('Sharding requires one isolation group');
          for (const name of ['a', 'b']) expect(result.stderr).toContain(`./src/${name}.test.ts`);
          expect(existsSync(join(root, 'loaded'))).toBe(false);
          expect(existsSync(join(root, 'rejected.xml'))).toBe(false);
        }
        expect(await run(root, ['a.test', '--shard=1/1'])).toBe(0);
        expect(readFileSync(join(root, 'loaded'), 'utf8')).toBe('yes');
      },
      testTimeout(5000)
    );
  }
}

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
  test(
    `requested JUnit combines every group: concurrency=${concurrency}`,
    async () => {
      const root = fixture({ testConcurrency: concurrency });
      testFile(root, 'a', `test('first', () => { throw new Error('expected'); });`, true);
      testFile(root, 'b', `test('second', () => {});`, true);
      testFile(root, 'c', `test('third', () => appendFileSync('third', 'ran'));`, true);
      const report = join(root, 'report.xml');
      expect(await run(root, ['src/', '--reporter=junit', '--reporter-outfile', report])).not.toBe(
        0
      );
      const xml = readFileSync(report, 'utf8');
      for (const name of ['first', 'second', 'third']) expect(xml).toContain(`name="${name}"`);
      expect(xml).toMatch(/<testsuites[^>]*tests="4"/);
      expect(xml).toMatch(/<testsuites[^>]*failures="1"/);
      expect(readFileSync(join(root, 'third'), 'utf8')).toBe('ran');
    },
    testTimeout(5000)
  );
}

for (const failure of [
  `throw new Error('top level');`,
  `import './missing-module';`,
  `const broken = ;`,
  `test('wanted', () => expect(1).toBe(2));`,
  `import { beforeAll } from 'bun:test'; beforeAll(() => { throw new Error('hook'); }); test('wanted', () => {});`,
  `import { afterAll } from 'bun:test'; afterAll(() => { throw new Error('cleanup'); }); test('wanted', () => {});`,
]) {
  test(
    `single-group failures stay red under name filters: ${failure}`,
    async () => {
      const root = fixture();
      testFile(root, 'a-skip', `test('other', () => {});`);
      testFile(root, 'b-broken', failure);
      testFile(root, 'c-match', `test('wanted', () => {});`);
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
    expect(existsSync(join(root, 'selected'))).toBe(false);
    expect(existsSync(join(root, 'isolated'))).toBe(false);
    expect(await run(root)).not.toBe(0);
  },
  testTimeout(5000)
);

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

for (const owner of ['test', 'describe']) {
  for (const modifier of ['skip', 'todo', 'skipIf(true)', 'todoIf(true)', 'if(false)']) {
    test(
      `matching ${owner}.${modifier} names succeed without executing skipped bodies`,
      async () => {
        const root = fixture();
        const body = `() => { throw new Error('must remain skipped'); }`;
        testFile(
          root,
          'skipped',
          owner === 'test'
            ? `test.${modifier}('wanted & "quoted"', ${body});`
            : `import { describe } from 'bun:test';
             describe.${modifier}('outer & "quoted" > segment', () => {
               describe('inner', () => { test('wanted', ${body}); });
             });`,
          true
        );
        const pattern =
          owner === 'test' ? '^wanted & "quoted"$' : '^outer & "quoted" > segment inner wanted$';
        for (const [filter, expected] of [
          [pattern, 0],
          ['absent', owner === 'describe' ? 0 : 1],
        ] as const) {
          const args = ['src/', '-t', filter];
          const code = await native(root, args);
          expect(code).toBe(expected);
          expect(await run(root, args)).toBe(code);
        }
      },
      testTimeout(5000)
    );
  }
}

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'requested read failures stop before executing groups or writing reports',
  async () => {
    const root = fixture();
    testFile(root, 'unreadable', `test('unreadable', () => {});`);
    testFile(root, 'unmarked', `mock.module('./value', () => ({}));`);
    testFile(root, 'shared', `test('shared', () => appendFileSync('shared', 'yes'));`);
    testFile(root, 'isolated', `test('isolated', () => appendFileSync('isolated', 'yes'));`, true);
    const unreadable = join(root, 'src/unreadable.test.ts');
    const report = join(root, 'discovery.xml');
    chmodSync(unreadable, 0);
    try {
      expect(await run(root, ['src/shared.test.ts'])).toBe(0);
      unlinkSync(join(root, 'shared'));
      expect(await run(root, ['src/', '--reporter=junit', '--reporter-outfile', report])).not.toBe(
        0
      );
      expect(existsSync(join(root, 'shared'))).toBe(false);
      expect(existsSync(join(root, 'isolated'))).toBe(false);
      expect(existsSync(report)).toBe(false);
      expect(await run(root)).not.toBe(0);
      expect(existsSync(join(root, 'shared'))).toBe(false);
    } finally {
      chmodSync(unreadable, 0o600);
    }
  },
  testTimeout(5000)
);

test('directive failures stop before executing groups or writing reports', async () => {
  const root = fixture();
  testFile(root, 'unmarked', `mock.module('./value', () => ({}));`);
  testFile(root, 'valid', `appendFileSync('loaded', 'yes'); test('valid', () => {});`, true);
  const report = join(root, 'discovery.xml');
  const result = await runResult(root, ['src/', '--reporter=junit', '--reporter-outfile', report]);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('unmarked.test.ts');
  expect(existsSync(join(root, 'loaded'))).toBe(false);
  expect(existsSync(report)).toBe(false);
});

for (const suffix of ['test', 'spec']) {
  for (const grouping of ['isolated', 'shared', 'legacy']) {
    test(`colliding ${suffix} filenames execute once: ${grouping}`, async () => {
      const declaration = grouping === 'legacy' ? { testGroups: [['src/']] } : {};
      const root = fixture(declaration);
      for (const extension of ['ts', 'tsx']) {
        writeFileSync(
          join(root, 'src', `a.${suffix}.${extension}`),
          `${grouping === 'shared' ? '' : TEST_ISOLATION_DIRECTIVE}\nimport { test } from 'bun:test';
          import { appendFileSync } from 'node:fs';
          test('${extension}', () => appendFileSync('ran', '${extension}:' + process.pid + '\\n'));`
        );
      }
      expect(await run(root, [`src/a.${suffix}.ts`])).toBe(0);
      const lines = readFileSync(join(root, 'ran'), 'utf8').trim().split('\n');
      expect(lines.map(line => line.split(':')[0]).sort()).toEqual(['ts', 'tsx']);
      expect(new Set(lines.map(line => line.split(':')[1])).size).toBe(
        grouping === 'isolated' ? 2 : 1
      );
      unlinkSync(join(root, 'ran'));
      expect(await run(root, [`src/a.${suffix}.tsx`])).toBe(0);
      expect(readFileSync(join(root, 'ran'), 'utf8').trim().split('\n')).toHaveLength(1);
    });
  }
}

for (const concurrency of [1, 2]) {
  test(
    `single-group name filters match native empty-name and skipped-suite outcomes: concurrency ${concurrency}`,
    async () => {
      const root = fixture({ testConcurrency: concurrency });
      const cases: { body: string; patterns: string[] }[] = [];
      for (const modifier of ['', '.skip', '.todo']) {
        const body = modifier === '' ? `() => {}` : `() => { throw new Error('skipped body'); }`;
        const testcase = `test${modifier}('wanted', ${body})`;
        cases.push(
          { body: `describe('', () => { ${testcase}; });`, patterns: ['^ wanted$', '^wanted$'] },
          {
            body: `describe('outer', () => describe('', () => { ${testcase}; }));`,
            patterns: ['^outer  wanted$', '^outer wanted$'],
          },
          { body: `test${modifier}('', ${body});`, patterns: ['^$'] },
          { body: `test${modifier}('wanted', ${body});`, patterns: ['^wanted$', 'absent'] },
          {
            body: `describe('outer', () => test${modifier}('', ${body}));`,
            patterns: ['^outer $', '^outer$'],
          }
        );
      }
      for (const modifier of ['skip', 'todo', 'skipIf(true)', 'todoIf(true)', 'if(false)']) {
        cases.push({
          body: `describe.${modifier}('suite', () => test('wanted', () => { throw new Error('skipped body'); }));`,
          patterns: ['absent'],
        });
      }
      const mismatches: {
        body: string;
        pattern: string;
        reporter: string[];
        native: number;
        wrapper: number;
      }[] = [];
      for (const scenario of cases) {
        testFile(root, 'names', `import { describe } from 'bun:test'; ${scenario.body}`, true);
        for (const pattern of scenario.patterns) {
          for (const reporter of [
            [],
            ['--reporter=junit', '--reporter-outfile', join(root, 'names.xml')],
          ]) {
            const args = ['src/', '-t', pattern, ...reporter];
            const expected = await native(root, args);
            const actual = await run(root, args);
            if (actual !== expected)
              mismatches.push({
                body: scenario.body,
                pattern,
                reporter,
                native: expected,
                wrapper: actual,
              });
          }
        }
      }
      expect(mismatches).toEqual([]);
    },
    testTimeout(30000)
  );
}

for (const modifier of ['', '.skip', '.todo']) {
  for (const scenario of [
    {
      name: 'empty outer suite',
      body: (test: string) => `describe('', () => { ${test} });`,
      matching: '^ wanted$',
      absent: '^wanted$',
    },
    {
      name: 'empty nested suite',
      body: (test: string) => `describe('outer', () => describe('', () => { ${test} }));`,
      matching: '^outer  wanted$',
      absent: '^outer wanted$',
    },
    {
      name: 'empty testcase',
      body: (test: string) => `describe('outer', () => { ${test.replace("'wanted'", "''")} });`,
      matching: '^outer $',
      absent: '^outer$',
    },
  ]) {
    test(
      `native name-filter outcomes survive ${scenario.name}: test${modifier}`,
      async () => {
        const root = fixture();
        testFile(
          root,
          'names',
          `import { describe } from 'bun:test';
${scenario.body(`test${modifier}('wanted', () => appendFileSync('executed', 'yes'));`)}`,
          true
        );
        for (const [pattern, expected] of [
          [scenario.matching, 0],
          [scenario.absent, 1],
        ] as const) {
          const args = ['src/', '-t', pattern];
          const code = await native(root, args);
          expect(code).toBe(expected);
          expect(await run(root, args)).toBe(code);
          const report = join(root, 'names.xml');
          expect(await run(root, [...args, '--reporter=junit', '--reporter-outfile', report])).toBe(
            code
          );
          expect(existsSync(report)).toBe(true);
        }
        expect(existsSync(join(root, 'executed'))).toBe(modifier === '');
      },
      testTimeout(5000)
    );
  }
}

for (const modifier of ['', '.skip', '.todo']) {
  test(
    `native empty root testcase remains unmatched: test${modifier}`,
    async () => {
      const root = fixture();
      testFile(root, 'names', `test${modifier}('', () => {});`, true);
      const args = ['src/', '-t', '^$'];
      const code = await native(root, args);
      expect(code).toBe(1);
      expect(await run(root, args)).toBe(code);
    },
    testTimeout(5000)
  );
}

for (const options of [[], ['--parallel=2'], ['--pass-with-no-tests']]) {
  test(
    `single-group name-filter results survive options ${JSON.stringify(options)}`,
    async () => {
      const root = fixture({ testConcurrency: 2 });
      testFile(root, 'a', `test('other', () => { throw new Error('filtered'); });`);
      testFile(root, 'b', `test.skip('wanted', () => { throw new Error('skipped'); });`);
      for (const pattern of ['wanted', 'absent']) {
        const args = ['src/', '-t', pattern, ...options];
        expect(await run(root, args)).toBe(await native(root, args));
      }
      testFile(root, 'b', `test('wanted', () => appendFileSync('ran', 'yes'));`);
      expect(await run(root, ['src/', '-t', 'wanted', ...options])).toBe(0);
      expect(readFileSync(join(root, 'ran'), 'utf8')).toBe('yes');
      testFile(root, 'b', `test('wanted', () => { throw new Error('real failure'); });`);
      expect(await run(root, ['src/', '-t', 'wanted', ...options])).not.toBe(0);
      testFile(root, 'b', `test('other', () => {}); throw new Error('load failure');`);
      expect(await run(root, ['src/', '-t', 'wanted', ...options])).not.toBe(0);
    },
    testTimeout(5000)
  );
}

test('single-group name filters preserve caller Bun options for test subprocesses', async () => {
  const root = fixture();
  testFile(
    root,
    'options',
    `test('wanted', async () => {
    const child = Bun.spawn([process.execPath, '-e', 'console.log(process.env.BUN_OPTIONS ?? "unset")'], { stdout: 'pipe' });
    expect(await new Response(child.stdout).text()).toBe(${JSON.stringify((process.env.BUN_OPTIONS ?? 'unset') + '\n')});
    expect(await child.exited).toBe(0);
  });`
  );
  expect(await run(root, ['src/', '-t', 'wanted'])).toBe(0);
});

for (const selection of ['mixed', 'uncovered', 'covered']) {
  test(`requested manifest coverage is enforced before execution: ${selection}`, async () => {
    const declaration = { testGroups: [['src/covered.test.ts']] };
    const root = fixture(declaration);
    testFile(root, 'covered', `test('covered', () => appendFileSync('covered', 'ran'));`);
    testFile(
      root,
      'unlisted',
      `test('unlisted', () => { throw new Error('must not disappear'); });`
    );
    const args =
      selection === 'mixed'
        ? ['src/']
        : [selection === 'covered' ? 'covered.test' : 'unlisted.test'];
    const report = join(root, 'coverage.xml');
    if (selection === 'covered') {
      expect(resolveRequestedTestGroups(root, declaration, args).groups).toEqual([
        ['./src/covered.test.ts'],
      ]);
    } else {
      expect(() => resolveRequestedTestGroups(root, declaration, args)).toThrow(
        'Requested test is not covered by testGroups: src/unlisted.test.ts'
      );
    }
    const result = await runResult(root, [
      ...args,
      '--reporter=junit',
      '--reporter-outfile',
      report,
    ]);
    expect(result.status).toBe(selection === 'covered' ? 0 : 1);
    expect(existsSync(join(root, 'covered'))).toBe(selection === 'covered');
    expect(existsSync(report)).toBe(selection === 'covered');
    if (selection === 'covered') expect(readFileSync(report, 'utf8')).toContain('name="covered"');
    else expect(result.stderr).toContain('src/unlisted.test.ts');
  });
}

test('every explicit package manifest accounts for a newly requested filename', async () => {
  for (const path of new Bun.Glob('packages/*/package.json').scanSync(
    join(import.meta.dir, '..')
  )) {
    const declaration = await Bun.file(join(import.meta.dir, '..', path)).json();
    if (declaration.testGroups === undefined) continue;
    const root = fixture(declaration);
    testFile(root, 'newly-added', `test('new', () => {});`);
    const covered = declaration.testGroups.some((group: string[]) =>
      group.some(selector => 'src/newly-added.test.ts'.includes(selector))
    );
    const resolve = () => resolveRequestedTestGroups(root, declaration, ['newly-added']);
    if (covered) expect(resolve().groups).toHaveLength(1);
    else expect(resolve).toThrow('Requested test is not covered by testGroups');
  }
});

test('JUnit destination follows the final reporter and outfile options', () => {
  for (const [args, expected] of [
    [[], undefined],
    [['--reporter=junit'], undefined],
    [['--reporter-outfile=ignored.xml'], undefined],
    [
      ['--reporter=junit', '--reporter-outfile=first.xml', '--reporter-outfile', 'last.xml'],
      'last.xml',
    ],
    [['--reporter=junit', '--reporter-outfile=result.xml', '--reporter=dots'], undefined],
    [['--reporter=dots', '--reporter=junit', '--reporter-outfile=result.xml'], 'result.xml'],
  ] satisfies [string[], string | undefined][]) {
    expect(junitDestination(parseTestArguments(args).optionTokens)).toBe(expected);
  }
});
