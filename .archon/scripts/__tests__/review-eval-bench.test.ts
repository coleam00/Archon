/**
 * The review-lens bench's own invariants, each one whose failure would silently
 * corrupt its numbers: a sample that can read the answer, a mislabelled version,
 * and a stale line.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { appendLine, latestLines, resolveVersion } from '../../workflows/sdlc/.shared/bench';
import { cloneSample, ensureOrigin, loadSet, prepareCase } from '../../workflows/sdlc/review-eval/scripts/bench';

const track = trackTempRoots();

function git(cwd: string, ...args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });
  return { code: result.status ?? 1, stdout: result.stdout.trim(), stderr: `${result.stderr} ${String(result.error ?? "")}` };
}

function ok(cwd: string, ...args: string[]): string {
  const result = git(cwd, ...args);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function write(root: string, path: string, content: string): void {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), content);
}

function commitAll(repo: string, message: string): string {
  ok(repo, 'add', '-A');
  ok(repo, 'commit', '-q', '-m', message);
  return ok(repo, 'rev-parse', 'HEAD');
}

/**
 * A repository whose history holds a base, a clean change and a later fix. The set
 * directory is in every one of those trees, as it is for a case whose base is newer
 * than the set, so dropping it is what keeps the answers out of a checkout.
 */
function caseRepository(): { repo: string; set: string; laterFix: string } {
  const repo = track(mkdtempSync(join(tmpdir(), 'archon-bench-repo-')));
  ok(repo, 'init', '-q', '-b', 'dev');
  write(repo, 'a.txt', 'one\n');
  write(repo, 'bench/README.md', 'The review bench set.\n');
  const base = commitAll(repo, 'base');
  write(repo, 'a.txt', 'one\ntwo\n');
  write(repo, 'b.txt', 'new\n');
  const clean = commitAll(repo, 'the change');
  write(repo, 'a.txt', 'one\ntwo\nfixed\n');
  const laterFix = commitAll(repo, 'later fix');

  write(repo, 'bench/work.md', 'Count to two.\n');
  write(repo, 'bench/v1.patch', 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+2\n');
  write(
    repo,
    'bench/set.json',
    JSON.stringify({
      bench: 'review-lenses',
      cases: [
        {
          id: 'counting',
          source: 'example/repo#7',
          title: 'Count to two',
          branch: 'feature/count',
          base_branch: 'dev',
          base,
          clean,
          date: '2026-10-01T12:00:00Z',
          work_order: 'work.md',
          known_defects: [],
          variants: [
            {
              id: 'v1',
              patch: 'v1.patch',
              defects: [{ id: 'D1', class: 'wrong_behaviour', owner: 'code', claim: 'Counts the wrong way.', location: 'a.txt:2' }],
            },
          ],
        },
      ],
    })
  );
  return { repo, set: join(repo, 'bench', 'set.json'), laterFix };
}

describe('prepare seals a case', () => {
  it('gives a sample only the base snapshot and its own variant', () => {
    const { repo, set: setPath, laterFix } = caseRepository();
    const out = track(mkdtempSync(join(tmpdir(), 'archon-bench-out-')));
    const set = loadSet(setPath);
    const bench = set.cases[0];
    const prepared = prepareCase(set, bench, repo, out);
    const origin = ensureOrigin(prepared, bench, 'test', out);
    const checkout = join(out, 'checkouts', 'eval-test', bench.id);
    cloneSample(prepared, bench, 'v1', origin, checkout);

    expect(ok(checkout, 'log', '--all', '--format=%H').split('\n')).toHaveLength(2);
    expect(git(checkout, 'cat-file', '-e', laterFix).code).not.toBe(0);
    expect(existsSync(join(checkout, 'bench'))).toBe(false);
    expect(git(checkout, 'cat-file', '-e', 'origin/dev:bench').code).not.toBe(0);
    expect(ok(checkout, 'diff', '--name-only', 'origin/dev...HEAD').split('\n')).toEqual(['a.txt', 'b.txt']);
    expect(ok(checkout, 'show', 'origin/dev:a.txt')).toBe('one');
    expect(ok(checkout, 'show', 'HEAD:a.txt')).toBe('one\n2');
    expect(ok(checkout, 'show', 'HEAD:b.txt')).toBe('new');
    expect(ok(checkout, 'branch', '--show-current')).toBe('feature/count');
    expect(ok(checkout, 'remote')).toBe('origin');
    expect(realpathSync(ok(checkout, 'remote', 'get-url', 'origin'))).toBe(realpathSync(origin));

    const elsewhere = track(mkdtempSync(join(tmpdir(), 'archon-bench-out-')));
    expect([...prepareCase(set, bench, repo, elsewhere).variants]).toEqual([...prepared.variants]);
  });
});

describe('resolveVersion refuses', () => {
  const subject = { workflow: 'archon-review-eval', promptDirs: ['.archon/workflows/sdlc/review'] };
  const tiers = {
    small: { provider: 'claude', model: 'haiku' },
    medium: { provider: 'claude', model: 'sonnet' },
    large: { provider: 'claude', model: 'opus' },
  };

  function packRepository(): { repo: string; sha: string; out: string } {
    const repo = track(mkdtempSync(join(tmpdir(), 'archon-bench-pack-')));
    ok(repo, 'init', '-q', '-b', 'dev');
    write(repo, '.archon/workflows/sdlc/review-eval/archon-review-eval.yaml', 'name: archon-review-eval\n');
    write(repo, '.archon/workflows/sdlc/review/commands/review-code.md', 'Review the code.\n');
    const sha = commitAll(repo, 'pack');
    return { repo, sha, out: track(mkdtempSync(join(tmpdir(), 'archon-bench-out-'))) };
  }

  function versionFile(dir: string, version: unknown): string {
    const file = join(dir, `version-${Math.random().toString(36).slice(2)}.yaml`);
    writeFileSync(file, JSON.stringify(version));
    return file;
  }

  it('a missing tier', () => {
    const { repo, sha, out } = packRepository();
    const file = versionFile(out, { label: 'v', pack_sha: sha, tiers: { small: tiers.small, medium: tiers.medium } });
    expect(() => resolveVersion(file, repo, out, subject)).toThrow('tier `large` is missing');
  });

  it('an unknown sha', () => {
    const { repo, out } = packRepository();
    const file = versionFile(out, { label: 'v', pack_sha: '0'.repeat(40), tiers });
    expect(() => resolveVersion(file, repo, out, subject)).toThrow('is not a commit');
  });

  it('a label reused with other tiers', () => {
    const { repo, sha, out } = packRepository();
    const first = resolveVersion(versionFile(out, { label: 'v', pack_sha: sha, tiers }), repo, out, subject);
    expect(first.version.prompt_sha).toEqual({
      '.archon/workflows/sdlc/review/commands/review-code.md': ok(repo, 'rev-parse', `${sha}:.archon/workflows/sdlc/review/commands/review-code.md`),
    });
    expect(existsSync(join(first.source, '.archon/workflows/sdlc/review-eval/archon-review-eval.yaml'))).toBe(true);
    appendLine(join(out, 'samples.jsonl'), { run_id: 'r1', version: first.version });

    const same = versionFile(out, { label: 'v', pack_sha: sha, tiers });
    expect(resolveVersion(same, repo, out, subject).version).toEqual(first.version);
    const other = versionFile(out, { label: 'v', pack_sha: sha, tiers: { ...tiers, large: { provider: 'codex', model: 'gpt' } } });
    expect(() => resolveVersion(other, repo, out, subject)).toThrow('label v already names another version');
  });
});

describe('latestLines keeps the newest line per key', () => {
  it('replaces an earlier line with a later one of the same key', () => {
    const out = track(mkdtempSync(join(tmpdir(), 'archon-bench-lines-')));
    const file = join(out, 'judgements.jsonl');
    appendLine(file, { run_id: 'a', verdict: 'old' });
    appendLine(file, { run_id: 'b', verdict: 'only' });
    appendLine(file, { run_id: 'a', verdict: 'new' });
    const latest = latestLines(file, line => String(line.run_id));
    expect([...latest.values()]).toEqual([
      { run_id: 'a', verdict: 'new' },
      { run_id: 'b', verdict: 'only' },
    ]);
  });
});
