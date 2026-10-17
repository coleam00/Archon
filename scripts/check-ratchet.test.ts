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
      function outer(xs: number[]) {
        return xs.map(x => (x > 0 ? x : -x));
      }
      describe('a', () => {
        it('b', () => {});
      });
    `;
    expect(Object.fromEntries(cognitiveUnits('sample.ts', source))).toEqual({
      nested: 3,
      branches: 3,
      mixed: 2,
      run: 1,
      outer: 0,
      'outer > xs.map()': 1,
      "describe('a')": 0,
      "describe('a') > it('b')": 0,
    });
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
    const result = checkRatchet(repo, 'main');
    expect(result.failures).toEqual([
      'src/a.ts: `run` cognitive complexity 1 -> 3',
      'src/a.ts: 4 -> 6 lines',
    ]);
    expect(result.remedies).toEqual(['Ratchet-Allow: src/a.ts:run', 'Ratchet-Allow: src/a.ts']);
  });

  test('allows each increase named by a trailer in the change', () => {
    const repo = repoOnBranch();
    write(repo, 'src/a.ts', COMPLEX);
    commitAll(repo, 'complicate\n\nRatchet-Allow: src/a.ts:run\nRatchet-Allow: src/a.ts');
    const result = checkRatchet(repo, 'main');
    expect(result.failures).toEqual([]);
    expect(result.allowed).toHaveLength(2);
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
    expect(checkRatchet(repo, 'main').failures).toContain(
      'src/a.ts: `run` cognitive complexity 1 -> 3'
    );
  });

  test('compares a moved function with its old file', () => {
    const repo = repoOnBranch();
    write(repo, 'src/a.ts', '');
    write(repo, 'src/b.ts', SIMPLE);
    commitAll(repo, 'move');
    expect(checkRatchet(repo, 'main').failures).toEqual([]);

    write(repo, 'src/b.ts', COMPLEX);
    expect(checkRatchet(repo, 'main').failures).toEqual([
      'src/b.ts: `run` cognitive complexity 1 -> 3 (base: src/a.ts)',
    ]);
  });

  test('compares a renamed file with the file it came from', () => {
    const repo = repoOnBranch();
    renameSync(join(repo, 'src/a.ts'), join(repo, 'src/renamed.ts'));
    write(repo, 'src/renamed.ts', `${SIMPLE}// one more line\n`);
    commitAll(repo, 'rename and grow');
    expect(checkRatchet(repo, 'main').failures).toEqual(['src/renamed.ts: 4 -> 5 lines']);
  });

  test('scores neither untouched files nor files outside the base Biome scope', () => {
    const repo = repoOnBranch();
    write(repo, 'gen/out.ts', COMPLEX);
    commitAll(repo, 'regenerate');
    expect(checkRatchet(repo, 'main').failures).toEqual([]);
  });

  test('reads the scope from the base, so a change cannot exclude its own file', () => {
    const repo = repoOnBranch();
    write(repo, 'biome.jsonc', '{ "files": { "includes": ["**", "!gen", "!src"] } }\n');
    write(repo, 'src/a.ts', COMPLEX);
    commitAll(repo, 'complicate and exclude');
    expect(checkRatchet(repo, 'main').failures).toHaveLength(2);
  });

  test('names the fetch when the base ref is missing', () => {
    const repo = repoOnBranch();
    expect(() => checkRatchet(repo, 'origin/dev')).toThrow('git fetch origin dev');
  });
});
