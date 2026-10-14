/**
 * The review-lens bench's own invariants, each one whose failure would silently
 * corrupt its numbers: a sample that can read the answer or differs by machine, a
 * mislabelled version, a failed, empty or misbound run counted as a sample, a paid run
 * left unrecorded, a live run's checkout reused, and a stale line.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { type ModelAliasPreset, TIER_NAMES, modelAliasPresetSchema } from '../../../packages/workflows/src/schemas/model-binding';
import {
  type ResolvedVersion,
  type RunDetail,
  type RunNode,
  TIERS,
  type TierBinding,
  appendLine,
  latestLines,
  readLines,
  resolveVersion,
} from '../../workflows/sdlc/.shared/bench';
import {
  cloneSample,
  collectItem,
  ensureOrigin,
  hardChecks,
  loadSet,
  prepareCase,
  runCost,
} from '../../workflows/sdlc/review-eval/scripts/bench';

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
function caseRepository(edit: (entry: Record<string, unknown>) => void = () => {}): {
  repo: string;
  set: string;
  laterFix: string;
} {
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
  const entry: Record<string, unknown> = {
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
  };
  edit(entry);
  write(repo, 'bench/set.json', JSON.stringify({ bench: 'review-lenses', cases: [entry] }));
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
    const gitDir = join(checkout, '.git');
    const leaks = readdirSync(gitDir, { recursive: true, encoding: 'utf8' })
      .filter(path => !path.startsWith('objects') && statSync(join(gitDir, path)).isFile())
      .filter(path => /variants|store\.git/.test(readFileSync(join(gitDir, path), 'latin1')));
    expect(leaks).toEqual([]);

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

describe("a version's tiers are the engine's", () => {
  it('names every tier the engine binds, in a shape its alias preset accepts', () => {
    expect([...TIERS]).toEqual([...TIER_NAMES]);
    const binding: TierBinding = { provider: 'claude', model: 'opus', effort: 'high' };
    expect(modelAliasPresetSchema.parse(binding)).toEqual({ provider: 'claude', model: 'opus', effort: 'high' });
    const fromEngine = (preset: ModelAliasPreset): TierBinding => preset;
    expect(fromEngine({ provider: 'codex', model: 'gpt' })).toEqual({ provider: 'codex', model: 'gpt' });
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

describe('a set or case that cannot be sealed is refused', () => {
  it('a date without a zone, whose variant SHAs would depend on the machine', () => {
    const { set } = caseRepository(entry => {
      entry.date = '2026-10-01T12:00:00';
    });
    expect(() => loadSet(set)).toThrow('date 2026-10-01T12:00:00 is not an ISO 8601 date ending in Z or ±hh:mm');
  });

  it('a defect whose owner is not a lens owning its class', () => {
    const { set } = caseRepository(entry => {
      entry.variants = [{ id: 'v1', patch: 'v1.patch', defects: [{ id: 'D1', class: 'weak_test', owner: 'code', claim: 'c', location: 'l' }] }];
    });
    expect(() => loadSet(set)).toThrow('owner must be one of tests for weak_test');
  });

  function refusal(edit: (entry: Record<string, unknown>) => void): () => void {
    const { repo, set: setPath } = caseRepository(edit);
    const set = loadSet(setPath);
    const out = track(mkdtempSync(join(tmpdir(), 'archon-bench-out-')));
    return () => prepareCase(set, set.cases[0], repo, out);
  }

  it('a variant equal to clean', () => {
    const prepare = refusal(entry => {
      entry.variants = [{ id: 'v1', tree: entry.clean, defects: [{ id: 'D1', class: 'wrong_behaviour', owner: 'code', claim: 'c', location: 'l' }] }];
    });
    expect(prepare).toThrow('variant v1 changes nothing in the clean tree');
  });

  it('a patch that does not apply', () => {
    const prepare = refusal(entry => {
      entry.variants = [{ id: 'v1', patch: 'README.md', defects: [{ id: 'D1', class: 'wrong_behaviour', owner: 'code', claim: 'c', location: 'l' }] }];
    });
    expect(prepare).toThrow('does not apply to clean');
  });

  it('a missing commit, naming the pull request ref to fetch', () => {
    const prepare = refusal(entry => {
      entry.clean = 'f'.repeat(40);
    });
    expect(prepare).toThrow('fetch refs/pull/7/head');
  });
});

describe('hard checks decide whether a sample counts', () => {
  const tiers = {
    small: { provider: 'claude', model: 'haiku' },
    medium: { provider: 'claude', model: 'sonnet' },
    large: { provider: 'claude', model: 'opus' },
  };
  const resolved: ResolvedVersion = {
    version: { label: 'v', pack_sha: 'a'.repeat(40), prompt_sha: {}, tiers, workflow: 'archon-review-eval', inputs: {} },
    source: '/unused',
    config: '/unused',
  };
  const provider = <T>(value: T) => ({ source: 'provider' as const, value });

  function agent(nodeId: string, binding: unknown, costUsd: number): RunNode {
    return {
      nodeId,
      state: 'completed',
      execution: {
        node: { kind: 'agent' },
        binding,
        spend: { costUsd: provider(costUsd), tokens: provider({ input: 10, output: 1 }) },
      },
    };
  }

  function run(overrides: Partial<RunDetail> = {}): RunDetail {
    return {
      id: 'r1',
      status: 'completed',
      output_root: '/unused',
      started_at: '2026-10-01T12:00:00Z',
      completed_at: '2026-10-01T12:10:00Z',
      base_branch: 'dev',
      aliases: tiers,
      nodes: [
        agent('review__code', { provider: 'claude', tier: 'large', model: { requested: 'opus', resolved: provider('claude-opus') } }, 1.5),
        agent('simplify__simplify', { provider: 'claude', tier: 'medium', model: { requested: 'sonnet', resolved: provider('claude-sonnet') } }, 0.25),
        { nodeId: 'review__review-complete', state: 'completed', execution: { node: { kind: 'bash' }, binding: {} } },
      ],
      ...overrides,
    };
  }

  const item = { lenses: ['code', 'simplify'], findings: true };
  const judge = (detail: RunDetail, output = item) => hardChecks(detail, resolved, output, { base_branch: 'dev' });

  it('pass a completed run on the version it names', () => {
    expect(judge(run())).toEqual({
      checks: {
        completed: { ok: true, problems: [] },
        output: { ok: true, problems: [] },
        sealed: { ok: true, problems: [] },
        version: { ok: true, problems: [] },
      },
      passed: true,
    });
  });

  it('fail a run that did not complete', () => {
    const verdict = judge(run({ status: 'failed' }));
    expect(verdict.passed).toBe(false);
    expect(verdict.checks.completed.problems).toEqual(['the run is failed']);
  });

  it('fail a completed run that left no review output', () => {
    const verdict = judge(run(), { lenses: [], findings: false });
    expect(verdict.passed).toBe(false);
    expect(verdict.checks.output.problems).toEqual(['the run left no lens file', 'the run left no review/findings.json']);
  });

  it('fail a run whose tier resolved to another model', () => {
    const verdict = judge(run({ aliases: { ...tiers, large: { provider: 'claude', model: 'sonnet' } } }));
    expect(verdict.passed).toBe(false);
    expect(verdict.checks.version.problems).toEqual(['tier large model is sonnet, not opus']);
  });

  it("fail a lens that ran another model than its tier's", () => {
    const nodes = [agent('review__code', { provider: 'claude', tier: 'large', model: { requested: 'sonnet' } }, 1), ...run().nodes.slice(1)];
    expect(judge(run({ nodes })).checks.version.problems).toEqual(["lens code ran claude/sonnet, not large's claude/opus"]);
  });

  it('fail, without throwing, a lens whose agent node has no provider binding', () => {
    const nodes = [agent('review__code', { tier: 'large' }, 1), ...run().nodes.slice(1)];
    expect(judge(run({ nodes })).checks.version.problems).toEqual(['lens code has no provider binding']);
  });

  it('total cost over agent nodes that ran, and none when any of them reported none', () => {
    const skipped: RunNode = {
      nodeId: 'review__docs',
      state: 'skipped',
      execution: { node: { kind: 'agent' }, binding: {}, spend: { costUsd: { source: 'unavailable', reason: 'not_applicable' } } },
    };
    expect(runCost(run({ nodes: [...run().nodes, skipped] }))).toEqual({ cost_usd: 1.75, tokens: { input: 20, output: 2 } });
    const unreported: RunNode = {
      nodeId: 'review__tests',
      state: 'completed',
      execution: { node: { kind: 'agent' }, binding: {}, spend: { costUsd: { source: 'unavailable', reason: 'not reported' } } },
    };
    expect(runCost(run({ nodes: [...run().nodes, unreported] })).cost_usd).toBeNull();
  });
});

describe('collectItem', () => {
  it('names lens files, not the review\'s own files, and sees findings.json', () => {
    const root = track(mkdtempSync(join(tmpdir(), 'archon-bench-item-')));
    const artifacts = join(root, 'artifacts', 'runs', 'r1');
    for (const file of ['code.md', 'scope.md', 'report.md', 'code-round-1.md', 'findings.json']) write(artifacts, `review/${file}`, 'x');
    write(artifacts, 'shape.md', 'x');
    const detail: RunDetail = {
      id: 'r1',
      status: 'completed',
      output_root: root,
      started_at: '2026-10-01T12:00:00Z',
      completed_at: null,
      base_branch: 'dev',
      aliases: {},
      nodes: [],
    };
    const itemDir = join(root, 'item');
    expect(collectItem(detail, itemDir)).toEqual({ lenses: ['code', 'simplify'], findings: true });
    expect(existsSync(join(itemDir, 'review', 'code-round-1.md'))).toBe(true);
    expect(existsSync(join(itemDir, 'shape.md'))).toBe(true);
  });
});

describe('bench run', () => {
  const script = join(import.meta.dir, '../../workflows/sdlc/review-eval/scripts/bench.ts');

  /**
   * `bench.ts run` over a case with an `archon` stub first on PATH: `run` acknowledges
   * numbered runs, `wait` answers with `wait`, and `get` returns a run detail missing
   * every field but id and status.
   */
  function benchCase(wait: unknown) {
    const { repo, set } = caseRepository();
    write(repo, '.archon/workflows/sdlc/review-eval/archon-review-eval.yaml', 'name: archon-review-eval\n');
    const packSha = commitAll(repo, 'pack');
    const out = track(mkdtempSync(join(tmpdir(), 'archon-bench-out-')));
    const tier = { provider: 'claude', model: 'opus' };
    writeFileSync(join(out, 'v.yaml'), JSON.stringify({ label: 'v', pack_sha: packSha, tiers: { small: tier, medium: tier, large: tier } }));

    const bin = track(mkdtempSync(join(tmpdir(), 'archon-bench-bin-')));
    const count = join(bin, 'count');
    writeFileSync(
      join(bin, 'archon'),
      [
        '#!/bin/sh',
        'case "$2" in',
        `  run) n=$(($(cat '${count}' 2>/dev/null || echo 0) + 1)); echo "$n" > '${count}'; echo "{\\"runId\\":\\"run-$n\\"}" ;;`,
        `  wait) echo '${JSON.stringify(wait)}' ;;`,
        `  get) echo "{\\"id\\":\\"$3\\",\\"status\\":\\"completed\\"}" ;;`,
        'esac',
        '',
      ].join('\n')
    );
    chmodSync(join(bin, 'archon'), 0o755);
    const run = (...args: string[]) => {
      const result = spawnSync(
        process.execPath,
        [script, 'run', '--set', set, '--batch', 'counting', '--version', join(out, 'v.yaml'), '--out', out, ...args],
        { cwd: repo, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }
      );
      return { status: result.status, stderr: result.stderr, lines: readLines(join(out, 'samples.jsonl')) };
    };
    return { out, run };
  }

  it('records every paid sample after the ones already taken, even when its detail cannot be read', () => {
    const { run } = benchCase({ attention: { kind: 'terminal', status: 'completed' } });
    expect(run('--variant', 'v1').status).toBe(1);
    const { status, lines } = run('--samples', '2');
    expect(status).toBe(1);
    expect(lines.map(line => [line.variant, line.sample, line.run_id, line.passed])).toEqual([
      ['v1', 1, 'run-1', false],
      ['clean', 1, 'run-2', false],
      ['clean', 2, 'run-3', false],
      ['v1', 2, 'run-4', false],
      ['v1', 3, 'run-5', false],
    ]);
    expect(String(lines[0].error)).toContain('the field `output_root` is missing');
  });

  it('stops the version, keeping the checkout, when a run does not finish', () => {
    const { out, run } = benchCase({ attention: { kind: 'stalled_tool_calls' } });
    const { status, stderr, lines } = run('--samples', '2');
    expect(status).toBe(1);
    expect(stderr).toContain('run run-1 may still be running');
    expect(lines.map(line => [line.run_id, line.passed])).toEqual([['run-1', false]]);
    expect(existsSync(join(out, 'checkouts', 'eval-v', 'counting', 'a.txt'))).toBe(true);
  });
});
