import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { checkRatchet, cognitiveUnits, lineCount } from './check-ratchet';

describe('cognitiveUnits', () => {
  test('scores nesting, flat branches and operator runs per function', () => {
    const source = `
      function nested(xs: number[]) {
        for (const x of xs) {
          if (x > 0) return x;
        }
        return 0;
      }
      function branches(x: number) {
        if (x === 1) return 'a';
        else if (x === 2) return 'b';
        else return 'c';
      }
      const mixed = (a: boolean, b: boolean, c: boolean) => (a && b) || c;
      const run = (a: boolean, b: boolean, c: boolean) => a && b && c;
      function others(x: number | null, xs: number[]) {
        switch (x) {
          case 1:
            if (xs.length) return 1;
        }
        try {
          outer: while (x) {
            do break outer; while (x);
          }
        } catch {
          if (x) return 2;
        }
        return x ?? 0;
      }
      function outer(xs: number[]) {
        return xs.map(x => (x > 0 ? x : -x));
      }
      describe('a', () => {
        it('b', () => {});
      });
    `;
    expect(Object.fromEntries(cognitiveUnits('sample.ts', source))).toEqual({
      nested: [3],
      branches: [3],
      mixed: [2],
      run: [1],
      others: [11],
      outer: [0],
      'outer > xs.map()': [1],
      "describe('a')": [0],
      "describe('a') > it('b')": [0],
    });
  });

  test('names a chained callback by the chain shape, not earlier callback bodies', () => {
    const names = (thenBody: string): string[] => [
      ...cognitiveUnits('sample.ts', `p.then(a => ${thenBody}).catch(e => (e ? 1 : 0));`).keys(),
    ];
    expect(names('a')).toEqual(['p.then()', 'p.then(_).catch()']);
    expect(names('(a ? a : 0)')).toEqual(names('a'));
  });

  test('keeps sibling chained callbacks distinct by their inner-call arguments', () => {
    const source = `function f() {
      run('a').catch(e => (e ? 1 : 0));
      run('b').catch(e => (e ? (e.x ? 1 : 2) : 0));
      xs[ i ].then(v => v);
    }`;
    expect(Object.fromEntries(cognitiveUnits('sample.ts', source))).toEqual({
      f: [0],
      "f > run('a').catch()": [1],
      "f > run('b').catch()": [3],
      'f > xs[i].then()': [0],
    });
  });

  test('does not rename a chained callback when a non-token inner argument changes', () => {
    const names = (argument: string): string[] => [
      ...cognitiveUnits('sample.ts', `run(${argument}).catch(e => (e ? 1 : 0));`).keys(),
    ];
    expect(names('{ retries: 1 }')).toEqual(['run(_).catch()']);
    expect(names('{ retries: 2, onError: () => 0 }')).toContain('run(_).catch()');
    expect(names('wrap(() => 1)')).toEqual(['wrap()', 'run(_).catch()']);
    expect(names('wrap(() => (x ? 1 : 2))')).toEqual(names('wrap(() => 1)'));
    expect(names('a, 1, this.b')).toEqual(['run(a,1,this.b).catch()']);
  });

  test('keeps every score of units that share an identity, highest first', () => {
    const source = 'function f(xs) { xs.forEach(x => x); xs.forEach(x => (x ? 1 : 0)); }';
    expect(cognitiveUnits('sample.ts', source).get('f > xs.forEach()')).toEqual([1, 0]);
  });

  test('counts a missing final newline as a line', () => {
    expect([lineCount(''), lineCount('a\n'), lineCount('a\nb')]).toEqual([0, 1, 2]);
  });
});

describe('checkRatchet', () => {
  const trackTempRoot = trackTempRoots();

  const git = (repo: string, ...args: string[]): void => {
    const result = Bun.spawnSync(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  };

  const write = (repo: string, path: string, content: string): void => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  };

  const commitAll = (repo: string, message: string): void => {
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', message);
  };

  /** Ceilings of zero make every increase count, so the comparison itself is what these tests see. */
  const NO_CEILING = { complexity: 0, lines: 0 };
  /** Admits the new files a move creates, and still holds a raised function above it. */
  const MOVE_CEILING = { complexity: 2, lines: 10 };

  const SIMPLE = 'export function run(x: number) {\n  if (x) return 1;\n  return 0;\n}\n';
  const COMPLEX =
    'export function run(x: number) {\n  if (x) {\n    if (x > 1) return 2;\n  }\n  return 0;\n}\n';
  const HOTSPOT =
    'export function hot(x: number) {\n  if (x) {\n    if (x) {\n      return 1;\n    }\n  }\n}\n';

  /** A `main` with one source file, an untouched hotspot and a Biome-excluded file. */
  function repoOnBranch(): string {
    const repo = trackTempRoot(mkdtempSync(join(tmpdir(), 'ratchet-')));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    write(repo, 'biome.jsonc', '{ "files": { "includes": ["**", "!gen"] } }\n');
    write(repo, 'src/a.ts', SIMPLE);
    write(repo, 'src/hot.ts', HOTSPOT);
    write(repo, 'gen/out.ts', SIMPLE);
    commitAll(repo, 'base');
    git(repo, 'checkout', '-q', '-b', 'change');
    return repo;
  }

  test('refuses a raised function and a longer file, naming both numbers', () => {
    const repo = repoOnBranch();
    write(repo, 'src/a.ts', COMPLEX);
    commitAll(repo, 'complicate');
    const result = checkRatchet(repo, 'main', NO_CEILING);
    expect(result.failures).toEqual([
      'src/a.ts: `run` cognitive complexity 1 -> 3',
      'src/a.ts: 4 -> 6 lines',
    ]);
    expect(result.remedies).toEqual(['Ratchet-Allow: src/a.ts:run', 'Ratchet-Allow: src/a.ts']);
  });

  test('refuses raising the lower of two callbacks that share an identity', () => {
    const repo = repoOnBranch();
    const siblings = (second: string): string =>
      `export function f(xs: number[]) {\n  xs.forEach(x => (x ? 1 : 0));\n  xs.forEach(${second});\n}\n`;
    write(repo, 'src/a.ts', siblings('x => x'));
    commitAll(repo, 'siblings');
    git(repo, 'branch', '-f', 'main');
    write(repo, 'src/a.ts', siblings('x => (x ? 1 : 0)'));
    expect(checkRatchet(repo, 'main', NO_CEILING).failures).toEqual([
      'src/a.ts: `f > xs.forEach()` cognitive complexity 0 -> 1',
    ]);
  });

  test('allows each increase named by a trailer in the change', () => {
    const repo = repoOnBranch();
    write(repo, 'src/a.ts', COMPLEX);
    commitAll(repo, 'complicate\n\nRatchet-Allow: src/a.ts:run\nRatchet-Allow: src/a.ts');
    const result = checkRatchet(repo, 'main', NO_CEILING);
    expect(result.failures).toEqual([]);
    expect(result.allowed).toHaveLength(2);
  });

  test('refuses entries the mock-module baseline gains unless a trailer allows them', () => {
    const repo = repoOnBranch();
    const baseline = (names: string[]): string =>
      JSON.stringify({ factories: { 'src/a.test.ts': ['./db'] }, exports: { 'src/db.ts': names } });
    write(repo, 'scripts/mock-module-baseline.json', baseline(['a']));
    commitAll(repo, 'baseline');
    git(repo, 'branch', '-f', 'main');
    write(repo, 'scripts/mock-module-baseline.json', baseline(['a', 'b']));
    commitAll(repo, 'grow');
    const result = checkRatchet(repo, 'main', NO_CEILING);
    expect(result.failures).toEqual([
      'scripts/mock-module-baseline.json: gains export src/db.ts b',
    ]);
    expect(result.remedies).toEqual(['Ratchet-Allow: scripts/mock-module-baseline.json']);

    git(
      repo,
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'waive\n\nRatchet-Allow: scripts/mock-module-baseline.json'
    );
    expect(checkRatchet(repo, 'main', NO_CEILING).failures).toEqual([]);
  });

  test('refuses a grandfathered factory the mock-module baseline gains', () => {
    const repo = repoOnBranch();
    const baseline = (factories: Record<string, string[]>): string =>
      JSON.stringify({ factories, exports: { 'src/db.ts': ['a'] } });
    write(repo, 'scripts/mock-module-baseline.json', baseline({ a: ['./db'] }));
    commitAll(repo, 'baseline');
    git(repo, 'branch', '-f', 'main');
    write(repo, 'scripts/mock-module-baseline.json', baseline({ a: ['./db'], b: ['./db'] }));
    commitAll(repo, 'grow');
    expect(checkRatchet(repo, 'main', NO_CEILING).failures).toEqual([
      "scripts/mock-module-baseline.json: gains factory b './db'",
    ]);
  });

  test('ignores a trailer the base already contains', () => {
    const repo = repoOnBranch();
    git(repo, 'checkout', '-q', 'main');
    git(
      repo,
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'earlier waiver\n\nRatchet-Allow: src/a.ts:run'
    );
    git(repo, 'checkout', '-q', 'change');
    git(repo, 'merge', '-q', '--ff-only', 'main');
    write(repo, 'src/a.ts', COMPLEX);
    commitAll(repo, 'complicate');
    expect(checkRatchet(repo, 'main', NO_CEILING).failures).toContain(
      'src/a.ts: `run` cognitive complexity 1 -> 3'
    );
  });

  test('compares a moved function with its old file', () => {
    const repo = repoOnBranch();
    write(repo, 'src/a.ts', '');
    write(repo, 'src/b.ts', SIMPLE);
    commitAll(repo, 'move');
    expect(checkRatchet(repo, 'main', MOVE_CEILING).failures).toEqual([]);

    write(repo, 'src/b.ts', COMPLEX);
    expect(checkRatchet(repo, 'main', MOVE_CEILING).failures).toEqual([
      'src/b.ts: `run` cognitive complexity 1 -> 3 (base: src/a.ts)',
    ]);
  });

  test('compares a function moved beside one that shares its identity', () => {
    const repo = repoOnBranch();
    const f = (...callbacks: string[]): string =>
      `export function f(xs: number[]) {\n${callbacks.map(c => `  xs.forEach(${c});\n`).join('')}}\n`;
    write(repo, 'src/a.ts', f('x => x'));
    write(repo, 'src/b.ts', `${f('x => (x ? 1 : 0)')}\n`);
    commitAll(repo, 'siblings in two files');
    git(repo, 'branch', '-f', 'main');
    write(repo, 'src/a.ts', '');
    write(repo, 'src/b.ts', f('x => (x ? 1 : 0)', 'x => x'));
    commitAll(repo, 'move');
    expect(checkRatchet(repo, 'main', NO_CEILING).failures).toEqual([]);

    write(repo, 'src/b.ts', f('x => (x ? 1 : 0)', 'x => (x ? 1 : 0)'));
    expect(checkRatchet(repo, 'main', NO_CEILING).failures).toEqual([
      'src/b.ts: `f > xs.forEach()` cognitive complexity 0 -> 1 (base: src/a.ts)',
    ]);
  });

  test('names the base file a failing score came from when a move merges two bases', () => {
    const repo = repoOnBranch();
    const f = (...callbacks: string[]): string =>
      `export function f(xs: number[]) {\n${callbacks.map(c => `  xs.forEach(${c});\n`).join('')}}\n`;
    const nested = 'x => (x ? (x ? 1 : 2) : 0)';
    write(repo, 'src/a.ts', f(nested));
    write(repo, 'src/b.ts', `${f('x => x')}\n`);
    commitAll(repo, 'siblings in two files');
    git(repo, 'branch', '-f', 'main');
    write(repo, 'src/a.ts', '');
    write(repo, 'src/b.ts', f(nested, 'x => (x ? 1 : 0)'));
    commitAll(repo, 'move and raise the own callback');
    expect(checkRatchet(repo, 'main', NO_CEILING).failures).toEqual([
      'src/b.ts: `f > xs.forEach()` cognitive complexity 0 -> 1',
    ]);
  });

  test('compares a renamed file with the file it came from', () => {
    const repo = repoOnBranch();
    renameSync(join(repo, 'src/a.ts'), join(repo, 'src/renamed.ts'));
    write(repo, 'src/renamed.ts', `${SIMPLE}// one more line\n`);
    commitAll(repo, 'rename and grow');
    expect(checkRatchet(repo, 'main', NO_CEILING).failures).toEqual([
      'src/renamed.ts: 4 -> 5 lines',
    ]);
  });

  test('does not treat a renamed file as a source of moved functions', () => {
    const repo = repoOnBranch();
    renameSync(join(repo, 'src/a.ts'), join(repo, 'src/renamed.ts'));
    write(repo, 'src/c.ts', COMPLEX);
    commitAll(repo, 'rename and add a same-named function');
    // Scored as new (from 0), not as a raise of the renamed file's `run` (from 1).
    expect(checkRatchet(repo, 'main', MOVE_CEILING).failures).toEqual([
      'src/c.ts: `run` cognitive complexity 0 -> 3',
    ]);
  });

  test('scores neither untouched files nor files outside the base Biome scope', () => {
    const repo = repoOnBranch();
    write(repo, 'gen/out.ts', COMPLEX);
    commitAll(repo, 'regenerate');
    expect(checkRatchet(repo, 'main', NO_CEILING).failures).toEqual([]);
  });

  test('reads the scope from the base, so a change cannot exclude its own file', () => {
    const repo = repoOnBranch();
    write(repo, 'biome.jsonc', '{ "files": { "includes": ["**", "!gen", "!src"] } }\n');
    write(repo, 'src/a.ts', COMPLEX);
    commitAll(repo, 'complicate and exclude');
    expect(checkRatchet(repo, 'main', NO_CEILING).failures).toHaveLength(2);
  });

  test('lets code grow below the ceiling and holds what is above it', () => {
    const repo = repoOnBranch();
    const ceilings = { complexity: 2, lines: 5 };
    write(repo, 'src/a.ts', COMPLEX);
    commitAll(repo, 'grow below the ceiling');
    // `run` goes 1 -> 3 and the file 4 -> 6 lines: both cross a ceiling, so both are refused.
    expect(checkRatchet(repo, 'main', ceilings).failures).toEqual([
      'src/a.ts: `run` cognitive complexity 1 -> 3',
      'src/a.ts: 4 -> 6 lines',
    ]);
    expect(checkRatchet(repo, 'main', { complexity: 3, lines: 6 }).failures).toEqual([]);
  });

  test('refuses a new function that lands above the ceiling', () => {
    const repo = repoOnBranch();
    write(repo, 'src/new.ts', COMPLEX);
    commitAll(repo, 'add');
    expect(checkRatchet(repo, 'main', { complexity: 2, lines: 100 }).failures).toEqual([
      'src/new.ts: `run` cognitive complexity 0 -> 3',
    ]);
  });

  test('puts no line ceiling on test files', () => {
    const repo = repoOnBranch();
    write(repo, 'src/a.test.ts', SIMPLE);
    commitAll(repo, 'add a test');
    git(repo, 'branch', '-f', 'main');
    write(repo, 'src/a.test.ts', `${SIMPLE}${'// more coverage\n'.repeat(20)}`);
    write(repo, 'src/__tests__/b.ts', SIMPLE.repeat(5));
    commitAll(repo, 'grow the tests');
    expect(checkRatchet(repo, 'main', { complexity: 100, lines: 5 }).failures).toEqual([]);
  });

  test('names the fetch when the base ref is missing', () => {
    const repo = repoOnBranch();
    expect(() => checkRatchet(repo, 'origin/dev', NO_CEILING)).toThrow('git fetch origin dev');
  });
});
