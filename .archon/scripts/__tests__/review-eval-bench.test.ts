/**
 * The review-lens bench's own invariants, each one whose failure would silently
 * corrupt its numbers: a sample that can read the answer or differs by machine, a
 * mislabelled version, a failed, empty or misbound run counted as a sample, spend that
 * reads as more complete than it was, a paid run left unrecorded, a live run's checkout
 * reused, a stale line, and a judge crediting a lens, defect or finding the sample does not
 * have.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from './temp-roots';
import {
  type ResolvedVersion,
  type RunDetail,
  type RunNode,
  readLines,
} from '../../workflows/sdlc/review-eval/scripts/runs';
import {
  hardChecks,
  type ReviewItem,
  runCost,
} from '../../workflows/sdlc/review-eval/scripts/bench';

const track = trackTempRoots();

/** A run's artifacts directory under its output root, where the bench reads a run's files. */
const runArtifacts = (root: string, runId: string): string => join(root, 'artifacts', 'runs', runId);

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
    return { nodeId, state: 'completed', kind: 'agent', binding, attempts: [{ costUsd: provider(costUsd), tokens: provider({ input: 10, output: 1 }) }] };
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
        { nodeId: 'review__review-complete', state: 'completed', kind: 'exec', binding: {}, attempts: [] },
      ],
      ...overrides,
    };
  }

  const item: ReviewItem = { lenses: ['code', 'simplify'], findingsProblem: null };
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

  it('fail a completed run in which a lens failed', () => {
    const failed: RunNode = { nodeId: 'review__errors', state: 'failed', kind: 'agent', binding: {}, attempts: [] };
    const verdict = judge(run({ nodes: [...run().nodes, failed] }));
    expect(verdict.passed).toBe(false);
    expect(verdict.checks.completed.problems).toEqual(['node review__errors failed']);
  });

  it('fail a run that diffed against another base branch', () => {
    const verdict = judge(run({ base_branch: 'main' }));
    expect(verdict.passed).toBe(false);
    expect(verdict.checks.sealed.problems).toEqual(["the run's base branch is main, not dev"]);
  });

  it('fail a completed run that left no review output', () => {
    const verdict = judge(run(), { lenses: [], findingsProblem: 'the run left no review/findings.json' });
    expect(verdict.passed).toBe(false);
    expect(verdict.checks.output.problems).toEqual([
      'the run left no lens file',
      'lens code ran but left no review/code.md',
      'lens simplify ran but left no shape.md',
      'the run left no review/findings.json',
    ]);
  });

  it('fail a run in which a lens the route selected left no file', () => {
    const tests = agent('review__tests', { provider: 'claude', tier: 'medium', model: { requested: 'sonnet' } }, 0.5);
    const skipped: RunNode = { nodeId: 'review__docs', state: 'skipped', kind: 'agent', binding: {}, attempts: [] };
    const verdict = judge(run({ nodes: [...run().nodes, tests, skipped] }));
    expect(verdict.passed).toBe(false);
    expect(verdict.checks.output.problems).toEqual(['lens tests ran but left no review/tests.md']);
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

  describe('spend', () => {
    const unavailable = { source: 'unavailable' as const, reason: 'not_reported' };
    const withAttempts = (attempts: RunNode['attempts']): RunDetail =>
      run({ nodes: [...run().nodes, { nodeId: 'review__tests', state: 'completed', kind: 'agent', binding: {}, attempts }] });

    it('sums every attempt of every agent node, a retried one included', () => {
      const retried = withAttempts([
        { costUsd: provider(1), tokens: provider({ input: 10, output: 1 }) },
        { costUsd: provider(2), tokens: provider({ input: 20, output: 2 }) },
      ]);
      expect(runCost(retried)).toEqual({ cost_usd: 4.75, cost_partial: false, tokens: { input: 50, output: 5 } });
    });

    it('counts an attempt that made no provider call as zero', () => {
      const none = { source: 'unavailable' as const, reason: 'not_applicable' };
      expect(runCost(withAttempts([{ costUsd: none, tokens: none }]))).toEqual({ cost_usd: 1.75, cost_partial: false, tokens: { input: 20, output: 2 } });
    });

    it('marks a cost that is only a floor as partial', () => {
      const floor = withAttempts([{ costUsd: { source: 'provider', value: 1, partial: true }, tokens: provider({ input: 1, output: 1 }) }]);
      expect(runCost(floor)).toMatchObject({ cost_usd: 2.75, cost_partial: true });
    });

    it('has no cost or tokens when any attempt reported none', () => {
      expect(runCost(withAttempts([{ costUsd: unavailable, tokens: provider({ input: 1, output: 1 }) }])).cost_usd).toBeNull();
      expect(runCost(withAttempts([{ costUsd: provider(1), tokens: unavailable }])).tokens).toBeNull();
    });
  });
});

describe('bench run', () => {
  const script = join(import.meta.dir, '../../workflows/sdlc/review-eval/scripts/bench.ts');
  const FAKE_ARCHON = join(import.meta.dir, 'fake-archon-cli.ts');

  /**
   * `bench.ts run` over a case with a fake `archon` (./fake-archon-cli.ts): `run` records
   * its arguments and acknowledges numbered runs, `wait` answers with `wait`, and `get`
   * returns `detail`, or a run detail missing every field but id and status.
   */
  function benchCase(wait: unknown, detail?: (out: string) => unknown) {
    const { repo, set } = caseRepository();
    write(repo, '.archon/workflows/sdlc/review-eval/archon-review-eval.yaml', 'name: archon-review-eval\n');
    const packSha = commitAll(repo, 'pack');
    const out = track(mkdtempSync(join(tmpdir(), 'archon-bench-out-')));
    const tier = { provider: 'claude', model: 'opus' };
    writeFileSync(join(out, 'v.yaml'), JSON.stringify({ label: 'v', pack_sha: packSha, tiers: { small: tier, medium: tier, large: tier } }));

    const cli = track(mkdtempSync(join(tmpdir(), 'archon-bench-cli-')));
    writeFileSync(join(cli, 'wait.json'), JSON.stringify(wait));
    if (detail !== undefined) writeFileSync(join(cli, 'detail.json'), JSON.stringify(detail(out)));
    const preload = join(cli, 'preload.ts');
    writeFileSync(preload, `import { install } from ${JSON.stringify(FAKE_ARCHON)};\ninstall(${JSON.stringify(cli)});\n`);
    const exec = (env: Record<string, string>, ...args: string[]) => {
      const result = spawnSync(process.execPath, ['--preload', preload, script, ...args], {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, ...env },
      });
      return { status: result.status, stderr: result.stderr, lines: readLines(join(out, 'samples.jsonl')) };
    };
    const runIn = (env: Record<string, string>, ...args: string[]) =>
      exec(env, 'run', '--set', set, '--batch', 'counting', '--version', join(out, 'v.yaml'), '--judge', 'opus', '--out', out, ...args);
    const run = (...args: string[]) => runIn({}, ...args);
    const judge = (...args: string[]) => exec({}, 'judge', '--out', out, '--judge', 'opus', ...args);
    const render = (...args: string[]) => exec({}, 'render', '--out', out, '--judge', 'opus', ...args);
    const argv = (n: number): unknown => JSON.parse(readFileSync(join(cli, `argv-${n}.json`), 'utf8'));
    /** The judge run `runId` returns `value` as its judgement. */
    const judgeReturns = (runId: string, value: unknown) =>
      writeFileSync(
        join(cli, `detail-${runId}.json`),
        JSON.stringify({ id: runId, status: 'completed', terminal_record: { returns: { availability: 'available', node_id: 'judge', value } } })
      );
    return { repo, out, cli, run, runIn, judge, render, judgeReturns, argv, packSha };
  }

  const tierOpus = { provider: 'claude', model: 'opus' };
  const binding = { provider: 'claude', tier: 'large', model: { requested: 'opus', resolved: { source: 'provider', value: 'claude-opus' } } };
  const spend = (costUsd: number) => ({ costUsd: { source: 'provider', value: costUsd }, tokens: { source: 'provider', value: { input: 10, output: 1 } } });
  // One attempt row per finished attempt; SQLite hands a row's data back as JSON text.
  const row = (nodeId: string, eventType: string, costUsd: number, scope: object = { accounting: 'node' }) => ({
    step_name: nodeId,
    event_type: eventType,
    data: JSON.stringify({ node: { id: nodeId, kind: 'agent' }, binding, spend: spend(costUsd), ...scope }),
  });
  /** `run-1`: a completed sample whose code lens and simplify left output, with one finding. */
  const passing = (root: string) => {
    const artifacts = runArtifacts(root, 'run-1');
    write(artifacts, 'review/code.md', 'x');
    write(artifacts, 'review/findings.json', JSON.stringify([{ id: 'R1', severity: 'note', sources: ['code'], claim: 'Unrelated.', status: 'open', round: 1 }]));
    write(artifacts, 'shape.md', 'x');
    return {
      id: 'run-1',
      status: 'completed',
      output_root: root,
      started_at: '2026-10-01T12:00:00Z',
      completed_at: '2026-10-01T12:10:00Z',
      metadata: {
        dispatch: { base_branch: 'dev' },
        model_bindings: { effective: { aliases: { small: tierOpus, medium: tierOpus, large: tierOpus } } },
      },
      terminal_record: {
        nodes: [
          { node_id: 'review__code', state: 'completed' },
          { node_id: 'simplify__simplify', state: 'completed' },
        ],
      },
      events: [
        row('review__code', 'node_failed', 0.5),
        row('review__code', 'node_completed', 1),
        // Roll-ups restating that spend, as current and older engines write them.
        row('review__code', 'node_completed', 1.5, { accounting: 'aggregate' }),
        row('review__code', 'node_completed', 1.5, { aggregate: true }),
        row('simplify__simplify', 'node_completed', 0.25),
      ],
    };
  };

  it('launches a sealed checkout with the work order and records a completed sample', () => {
    const { out, run, argv, packSha, judgeReturns } = benchCase({ attention: { kind: 'terminal', status: 'completed' } }, passing);
    judgeReturns('run-2', { defects: [{ id: 'D1', caught_by: [], finding: null, evidence: 'Missed.' }], shape_unmatched: 0 });
    const { status, lines } = run('--variant', 'v1');
    expect(status).toBe(0);

    const checkout = join(out, 'checkouts', 'eval-v', 'counting');
    expect(argv(1)).toEqual([
      'workflow',
      'run',
      'archon-review-eval',
      '--cwd',
      checkout,
      '--no-worktree',
      '--workflow-source',
      join(out, 'sources', packSha),
      '--config',
      join(out, 'versions', 'v.config.yaml'),
      '--input',
      'work_order=Count to two.\n',
      '--detach',
      '--json',
      "Review this branch's change against its merge-base with dev. It has no pull request; declare pr as null.",
    ]);

    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect([line.case, line.variant, line.sample, line.run_id, line.status, line.passed]).toEqual(['counting', 'v1', 1, 'run-1', 'completed', true]);
    expect(line.version).toMatchObject({ label: 'v', pack_sha: packSha });
    const lens = { tier: 'large', provider: 'claude', model: 'opus', resolved_model: 'claude-opus', cost_partial: false };
    expect(line.lenses).toEqual({
      code: { node: 'review__code', ...lens, attempts: 2, cost_usd: 1.5, tokens: { input: 20, output: 2 } },
      simplify: { node: 'simplify__simplify', ...lens, attempts: 1, cost_usd: 0.25, tokens: { input: 10, output: 1 } },
    });
    expect([line.cost_usd, line.tokens, line.duration_ms, line.item]).toEqual([1.75, { input: 30, output: 3 }, 600_000, join('items', 'run-1')]);
    expect(existsSync(join(out, 'checkouts', 'eval-v', 'counting.run'))).toBe(false);
    expect(existsSync(join(out, 'items', 'run-1', 'review', 'code.md'))).toBe(true);
  });

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
    expect(String(lines[0].error)).toContain('the field `terminal_record.nodes` is missing');
    const repeated = run('--samples', '2', '--variant', 'v1', '--variant', 'v1');
    expect(repeated.status).toBe(1);
    expect(repeated.lines.slice(5).map(line => [line.variant, line.sample, line.run_id, line.passed])).toEqual([
      ['v1', 4, 'run-6', false],
      ['v1', 5, 'run-7', false],
      ['v1', 6, 'run-8', false],
      ['v1', 7, 'run-9', false],
    ]);
  });

  it('stops the version, and keeps the checkout from any later bench, when a run does not finish', () => {
    const { out, cli, run } = benchCase({ attention: { kind: 'stalled_tool_calls' } });
    const { status, stderr, lines } = run('--samples', '2');
    expect(status).toBe(1);
    expect(stderr).toContain('run run-1 may still be running');
    expect(lines.map(line => [line.run_id, line.passed])).toEqual([['run-1', false]]);
    const checkout = join(out, 'checkouts', 'eval-v', 'counting');
    writeFileSync(join(checkout, 'work-in-progress'), 'x');

    const again = run('--variant', 'clean');
    expect(again.status).toBe(1);
    expect(again.stderr).toContain(`${checkout} is held by run run-1`);
    expect(existsSync(join(checkout, 'work-in-progress'))).toBe(true);
    expect(existsSync(join(cli, 'argv-2.json'))).toBe(false);
  });

  it('releases the checkout after a refused launch, and keeps it held after one that may have started a run', () => {
    const { out, cli, run } = benchCase({ attention: { kind: 'terminal', status: 'completed' } });
    const checkout = join(out, 'checkouts', 'eval-v', 'counting');
    const hold = `${checkout}.run`;
    writeFileSync(join(cli, 'launch.txt'), JSON.stringify({ ok: false, error: 'workflow not found' }));
    const refused = run('--variant', 'v1');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('refused: workflow not found');
    expect(existsSync(hold)).toBe(false);

    writeFileSync(join(cli, 'launch.txt'), 'Started in the background.');
    const unclear = run('--variant', 'v1');
    expect(unclear.status).toBe(1);
    expect(unclear.stderr).toContain(`the launch may have started a run in ${checkout}, so ${hold} stays`);
    expect(existsSync(hold)).toBe(true);

    const again = run('--variant', 'v1');
    expect(again.stderr).toContain(`${checkout} is held by a run whose id is unknown`);
    expect(existsSync(join(cli, 'argv-3.json'))).toBe(false);
    expect(again.lines).toEqual([]);
  });

  it('refuses to launch a checkout that can reach another remote', () => {
    const { out, cli, runIn } = benchCase({ attention: { kind: 'terminal', status: 'completed' } });
    // Git config the operator's machine adds to every repository reaches the checkout too.
    const leak = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'remote.upstream.url', GIT_CONFIG_VALUE_0: 'https://example.invalid/repo.git' };
    const { status, stderr } = runIn(leak, '--variant', 'v1');
    expect(status).toBe(1);
    expect(stderr).toContain('v counting/v1: not sealed: remotes are origin, upstream, not only origin');
    expect(existsSync(join(cli, 'argv-1.json'))).toBe(false);
    expect(existsSync(join(out, 'samples.jsonl'))).toBe(false);
    expect(existsSync(join(out, 'checkouts', 'eval-v', 'counting.run'))).toBe(false);
  });
});
