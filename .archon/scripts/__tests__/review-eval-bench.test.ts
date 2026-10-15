/**
 * The review-lens bench's own invariants, each one whose failure would silently
 * corrupt its numbers: a sample that can read the answer or differs by machine, a
 * mislabelled version, a failed, empty or misbound run counted as a sample, spend that
 * reads as more complete than it was, a paid run left unrecorded, a live run's checkout
 * reused, a stale line, a judge crediting a lens, defect or finding the sample does not
 * have, and an operator's mark overwritten.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRunArtifactsDirForRoot } from '@archon/paths';
import { trackTempRoots } from '@archon/paths/test-utils';
import { nodeCostScope } from '../../../packages/workflows/src/node-record-serialization';
import { EFFORT_LEVELS } from '../../../packages/workflows/src/schemas/effort';
import { type ModelAliasPreset, TIER_NAMES, modelAliasPresetSchema } from '../../../packages/workflows/src/schemas/model-binding';
import {
  executionBindingSchema,
  executionSpendSchema,
  nodeExecutionMetadataSchema,
  unavailableMeasurementSchema,
} from '../../../packages/workflows/src/schemas/node-execution';
import {
  type ResolvedVersion,
  type RunDetail,
  type RunNode,
  EFFORTS,
  type FindingMark,
  MARKS,
  TIERS,
  type TierBinding,
  agentBinding,
  appendLine,
  artifactsOf,
  latestLines,
  readLines,
  reportsOwnSpend,
  resolveVersion,
  spendOf,
} from '../../workflows/sdlc/.shared/bench';
import {
  cloneSample,
  collectItem,
  ensureOrigin,
  hardChecks,
  loadSet,
  mergeMarks,
  prepareCase,
  type ReviewItem,
  runCost,
  validateJudgement,
  writeBatch,
} from '../../workflows/sdlc/review-eval/scripts/bench';
import { type Finding, type ItemRecord, readFindings, writeItem } from '../../workflows/sdlc/.shared/review-item';
import { MARKS as INTAKE_MARKS } from '../../workflows/sdlc/intake/scripts/bench/score';

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

  it('an effort the engine would refuse', () => {
    const { repo, sha, out } = packRepository();
    const file = versionFile(out, { label: 'v', pack_sha: sha, tiers: { ...tiers, large: { ...tiers.large, effort: 'extreme' } } });
    expect(() => resolveVersion(file, repo, out, subject)).toThrow('tier `large` effort must be one of');
  });
});

describe("a version's tiers are the engine's", () => {
  it('names every tier and effort the engine binds, in a shape its alias preset accepts', () => {
    expect([...TIERS]).toEqual([...TIER_NAMES]);
    expect([...EFFORTS]).toEqual([...EFFORT_LEVELS]);
    const binding: TierBinding = { provider: 'claude', model: 'opus', effort: 'high' };
    expect(modelAliasPresetSchema.parse(binding)).toEqual({ provider: 'claude', model: 'opus', effort: 'high' });
    const fromEngine = (preset: ModelAliasPreset): TierBinding => preset;
    expect(fromEngine({ provider: 'codex', model: 'gpt' })).toEqual({ provider: 'codex', model: 'gpt' });
  });
});

describe("a run's spend and binding are read on the engine's terms", () => {
  const unmeasured = { source: 'unavailable', reason: 'not_reported' } as const;
  const spend = (fields: object) => executionSpendSchema.parse({ stopReason: unmeasured, numTurns: unmeasured, ...fields });

  it('counts a row as own spend exactly when the engine does, legacy roll-ups included', () => {
    const rows = [
      ...nodeExecutionMetadataSchema.shape.accounting.options.map(accounting => ({ accounting })),
      {},
      { aggregate: true },
      { aggregate: false },
    ];
    expect(rows.map(reportsOwnSpend)).toEqual(rows.map(row => nodeCostScope(row) === 'own'));
  });

  it('reads every unavailable reason, a floor cost and a resolved model as the engine writes them', () => {
    for (const reason of unavailableMeasurementSchema.shape.reason.options) {
      const none = { source: 'unavailable', reason };
      const known = reason === 'not_applicable';
      expect(spendOf([spend({ tokens: none, costUsd: none })])).toEqual({
        cost_usd: known ? 0 : null,
        cost_partial: false,
        tokens: known ? { input: 0, output: 0 } : null,
      });
    }
    const floor = spend({
      tokens: { source: 'provider', value: { input: 3, output: 1, cacheRead: 2 } },
      costUsd: { source: 'provider', value: 1.5, partial: true },
    });
    expect(spendOf([floor])).toEqual({ cost_usd: 1.5, cost_partial: true, tokens: { input: 3, output: 1 } });

    const binding = executionBindingSchema.parse({
      provider: 'claude',
      tier: 'large',
      effort: 'high',
      model: { requested: 'opus', resolved: { source: 'provider', value: 'claude-opus' } },
    });
    expect(agentBinding({ nodeId: 'review__code', state: 'completed', kind: 'agent', binding, attempts: [] })).toEqual({
      provider: 'claude',
      tier: 'large',
      requested: 'opus',
      resolved: 'claude-opus',
    });
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
      transcript_path: null,
      returns: null,
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

describe('collectItem', () => {
  it('reads the artifacts directory the engine writes', () => {
    const detail = { id: 'r1', output_root: '/home/me/.archon/workspaces/o/r' } as const;
    expect(artifactsOf({ ...detail, status: 'completed', started_at: '', completed_at: null, base_branch: 'dev', aliases: {}, transcript_path: null, returns: null, nodes: [] })).toBe(
      getRunArtifactsDirForRoot(detail.output_root, detail.id)
    );
  });

  it('names lens files, not the review\'s own files, and reads findings.json', () => {
    const root = track(mkdtempSync(join(tmpdir(), 'archon-bench-item-')));
    const artifacts = getRunArtifactsDirForRoot(root, 'r1');
    for (const file of ['code.md', 'scope.md', 'report.md', 'discoveries.md', 'code-round-1.md']) {
      write(artifacts, `review/${file}`, 'x');
    }
    write(artifacts, 'review/findings.json', '[]');
    write(artifacts, 'shape.md', 'x');
    const detail: RunDetail = {
      id: 'r1',
      status: 'completed',
      output_root: root,
      started_at: '2026-10-01T12:00:00Z',
      completed_at: null,
      base_branch: 'dev',
      aliases: {},
      transcript_path: null,
      returns: null,
      nodes: [],
    };
    const itemDir = join(root, 'item');
    expect(collectItem(detail, itemDir)).toEqual({ lenses: ['code', 'simplify'], findingsProblem: null });
    expect(existsSync(join(itemDir, 'review', 'code-round-1.md'))).toBe(true);
    expect(existsSync(join(itemDir, 'shape.md'))).toBe(true);
  });
});

describe('saved review evidence', () => {
  it('uses the same operator judgement vocabulary as intake', () => {
    expect(INTAKE_MARKS).toBe(MARKS.defect);
  });

  it('rejects a finding without its first review round', () => {
    const dir = track(mkdtempSync(join(tmpdir(), 'archon-finding-')));
    const finding = { id: 'R1', severity: 'blocking', sources: ['code'], claim: 'Wrong count.', status: 'open' };
    for (const round of [undefined, '1', 0, -1, 1.5]) {
      write(dir, 'review/findings.json', JSON.stringify([{ ...finding, round }]));
      expect(() => readFindings(dir)).toThrow('is not a list of findings');
    }
    write(dir, 'review/findings.json', JSON.stringify([{ ...finding, round: 2 }]));
    expect(readFindings(dir)).toEqual([{ ...finding, round: 2 }]);
  });

  it('conforms to the synthesizer’s persisted finding contract', () => {
    const finding: Finding = { id: 'R1', severity: 'blocking', sources: ['code'], claim: 'Wrong count.', status: 'open', round: 1 };
    const prompt = readFileSync(join(import.meta.dir, '../../workflows/sdlc/review/commands/review-synthesize.md'), 'utf8');
    expect(prompt).toContain(`A JSON array of \`{${Object.keys(finding).join(', ')}}\``);
    const dir = track(mkdtempSync(join(tmpdir(), 'archon-finding-contract-')));
    write(dir, 'review/findings.json', JSON.stringify([finding]));
    expect(readFindings(dir)).toEqual([finding]);
    for (const key of Object.keys(finding)) {
      write(dir, 'review/findings.json', JSON.stringify([Object.fromEntries(Object.entries(finding).filter(([field]) => field !== key))]));
      expect(() => readFindings(dir)).toThrow('is not a list of findings');
    }
  });

  function savedItem() {
    const dir = track(mkdtempSync(join(tmpdir(), 'archon-reader-')));
    const item: ItemRecord = {
      case: 'counting', variant: 'v1',
      defects: [{ id: 'D1', class: 'wrong_behaviour', owner: 'code', claim: 'Counts down.', location: 'a.ts:2' }],
      known_defects: [{ id: 'K1', claim: 'Never stops.' }],
      lenses: { code: 'review/code.md', simplify: 'shape.md' },
    };
    writeItem(dir, item);
    write(dir, 'review/code.md', 'The counter decrements at a.ts:2.');
    write(dir, 'shape.md', 'Use the existing counter primitive.');
    write(dir, 'review/findings.json', '[{"id":"R1","severity":"blocking","sources":["code"],"claim":"Counts down.","status":"open","round":1}]');
    return { dir, item };
  }

  function read(dir: string) {
    return spawnSync(process.execPath, [join(import.meta.dir, '../../workflows/sdlc/review-eval-judge/scripts/read-item.ts')], {
      encoding: 'utf8', env: { ...process.env, INPUTS_ITEM: dir },
    });
  }

  it('reader supplies the actual named lens, defect, finding and report evidence', () => {
    const { dir, item } = savedItem();
    write(dir, 'review/report.md', 'The review concludes the count is wrong.');
    const result = read(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`<defects>\n${JSON.stringify(item.defects, null, 2)}\n</defects>`);
    expect(result.stdout).toContain(`<known_defects>\n${JSON.stringify(item.known_defects, null, 2)}\n</known_defects>`);
    expect(result.stdout).toContain('<lens name="code" file="review/code.md">\nThe counter decrements at a.ts:2.\n</lens>');
    expect(result.stdout).toContain('<lens name="simplify" file="shape.md">\nUse the existing counter primitive.\n</lens>');
    expect(result.stdout).toContain(`<findings file="review/findings.json">\n${readFileSync(join(dir, 'review/findings.json'), 'utf8')}\n</findings>`);
    expect(result.stdout).toContain('<report file="review/report.md">\nThe review concludes the count is wrong.\n</report>');
  });

  it('reader refuses a missing declared lens but permits an absent optional report', () => {
    const { dir, item } = savedItem();
    expect(read(dir).stdout).toContain('<report file="review/report.md">\n(absent)\n</report>');
    writeItem(dir, { ...item, lenses: { errors: 'review/errors.md' } });
    const result = read(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(join(dir, 'review/errors.md'));
    expect(result.stdout).toBe('');
  });
});

describe('latestLines', () => {
  it('keeps the newest line per key and skips lines with none', () => {
    const file = join(track(mkdtempSync(join(tmpdir(), 'archon-bench-lines-'))), 'lines.jsonl');
    for (const line of [{ k: 'a', n: 1 }, { k: 'b', n: 2 }, { n: 3 }, { k: 'a', n: 4 }]) appendLine(file, line);
    const latest = latestLines(file, line => (typeof line.k === 'string' ? line.k : undefined));
    expect([...latest.entries()]).toEqual([
      ['a', { k: 'a', n: 4 }],
      ['b', { k: 'b', n: 2 }],
    ]);
  });
});

describe('the batch page and marks', () => {
  it('shows a cost that is only a floor as at least that much', () => {
    const out = track(mkdtempSync(join(tmpdir(), 'archon-bench-page-')));
    const sample = { case: 'counting', variant: 'v1', run_id: 'run-1', version: { label: 'v' }, passed: true };
    appendLine(join(out, 'samples.jsonl'), { ...sample, sample: 1, cost_usd: 1.5, cost_partial: true });
    appendLine(join(out, 'samples.jsonl'), { ...sample, sample: 2, run_id: 'run-2', cost_usd: 2, cost_partial: false });
    writeBatch(out, 'counting', 'opus');
    expect(readFileSync(join(out, 'batches', 'counting', 'page.md'), 'utf8')).toContain('| Cost | at least $1.50 | $2.00 |');
  });

  it('excludes a known defect’s accounted finding from clean false-positive candidates', () => {
    const out = track(mkdtempSync(join(tmpdir(), 'archon-clean-page-')));
    const dir = join(out, 'items', 'run-1');
    mkdirSync(dir, { recursive: true });
    writeItem(dir, { case: 'counting', variant: 'clean', defects: [], known_defects: [{ id: 'K1', claim: 'Never stops.' }], lenses: { code: 'review/code.md' } });
    write(dir, 'review/findings.json', JSON.stringify([
      { id: 'R1', severity: 'blocking', sources: ['code'], claim: 'Never stops.', status: 'open', round: 1 },
      { id: 'R2', severity: 'note', sources: ['code'], claim: 'Unlinked problem.', status: 'open', round: 1 },
    ]));
    appendLine(join(out, 'samples.jsonl'), { case: 'counting', variant: 'clean', sample: 1, run_id: 'run-1', version: { label: 'v' }, passed: true, item: join('items', 'run-1') });
    appendLine(join(out, 'judgements.jsonl'), { run_id: 'run-1', judge: { spec: 'opus' }, valid: true, defects: [{ id: 'K1', caught_by: ['code'], finding: 'R1', excerpt: null, evidence: 'States the mechanism.' }], shape_unmatched: 0 });
    writeBatch(out, 'counting', 'opus');
    const batch = join(out, 'batches', 'counting');
    const page = readFileSync(join(batch, 'page.md'), 'utf8');
    expect(page).toContain('### Known `K1`');
    const candidates = page.split('### Findings no defect accounts for')[1];
    expect(candidates).toContain('R2 (code, open): Unlinked problem.');
    expect(candidates).not.toContain('R1');
    const marks = Bun.YAML.parse(readFileSync(join(batch, 'marks.yaml'), 'utf8')) as Record<string, unknown>[];
    expect(marks.map(entry => entry.defect ?? entry.finding)).toEqual(['K1', 'R2']);
  });

  it('leaves both batch outputs unchanged when saved marks are malformed', () => {
    const out = track(mkdtempSync(join(tmpdir(), 'archon-marks-refusal-')));
    const batch = join(out, 'batches', 'counting');
    write(batch, 'page.md', 'Previous page.');
    write(batch, 'marks.yaml', 'not_a_list: true');
    expect(() => writeBatch(out, 'counting', 'opus')).toThrow('is not a list of marks');
    expect(readFileSync(join(batch, 'page.md'), 'utf8')).toBe('Previous page.');
    expect(readFileSync(join(batch, 'marks.yaml'), 'utf8')).toBe('not_a_list: true');
  });

  it('keeps a marked or annotated entry a re-judge no longer calls for, and drops an unmarked one', () => {
    const file = join(track(mkdtempSync(join(tmpdir(), 'archon-bench-marks-'))), 'marks.yaml');
    const at = { run_id: 'run-1', version: 'v', variant: 'clean', sample: 1 };
    const finding = (id: string, mark: FindingMark | null, note: string | null) => ({ ...at, finding: id, sources: ['code'], claim: 'Unrelated.', mark, note });
    const marked = finding('R1', 'false_positive', null);
    const annotated = finding('R2', null, 'Look again.');
    const corrected = { ...at, defect: 'K1', judge: { caught_by: [], finding: null }, mark: null, note: null, caught_by: ['code'] };
    writeFileSync(file, Bun.YAML.stringify([marked, annotated, corrected, finding('R3', null, null)], null, 2));
    const regenerated = finding('R4', null, null);
    expect(mergeMarks(file, [regenerated])).toEqual([regenerated, marked, annotated, corrected]);
  });
});

describe('judgement validation', () => {
  const item: ItemRecord = {
    case: 'counting',
    variant: 'v1',
    defects: [{ id: 'D1', class: 'wrong_behaviour', owner: 'code', claim: 'Counts the wrong way.', location: 'a.txt:2' }],
    known_defects: [{ id: 'K1', claim: 'It never stops.' }],
    lenses: { code: 'review/code.md', simplify: 'shape.md' },
  };
  const findings: Finding[] = [{ id: 'R1', severity: 'blocking', sources: ['code'], claim: 'Wrong count.', status: 'open', round: 1 }];
  const entry = (id: string, caughtBy: string[] = [], finding: string | null = null) => ({
    id,
    caught_by: caughtBy,
    finding,
    excerpt: null,
    evidence: 'Why.',
  });
  const judge = (...defects: unknown[]) => validateJudgement({ defects, shape_unmatched: 0 }, item, findings);

  it('accepts every planted and known defect judged once against the lenses and findings present', () => {
    expect(judge(entry('D1', ['code', 'simplify'], 'R1'), entry('K1'))).toMatchObject({ valid: true, shape_unmatched: 0 });
  });

  it('refuses a lens that left no output, an unknown defect, and a finding the review never recorded', () => {
    expect(judge(entry('D1', ['docs']), entry('K1'))).toEqual({ valid: false, reason: 'defect D1: lens docs left no output in this sample' });
    expect(judge(entry('D1'), entry('K1'), entry('D9'))).toEqual({ valid: false, reason: 'unknown defect D9' });
    expect(judge(entry('D1', ['code'], 'R7'), entry('K1'))).toEqual({
      valid: false,
      reason: 'defect D1: review/findings.json has no finding R7',
    });
  });

  it('refuses a defect left unjudged or judged twice, and a malformed count', () => {
    expect(judge(entry('D1'))).toEqual({ valid: false, reason: 'not judged: K1' });
    expect(judge(entry('D1'), entry('D1'), entry('K1'))).toEqual({ valid: false, reason: 'defect D1 is judged twice' });
    expect(validateJudgement({ defects: [entry('D1'), entry('K1')], shape_unmatched: -1 }, item, findings)).toEqual({
      valid: false,
      reason: 'shape_unmatched is not a count',
    });
  });

  it("accepts the judge fixture's output, whose fields are exactly the judge schema's", () => {
    const dir = join(import.meta.dir, '../../workflows/sdlc/review-eval-judge');
    const workflow = Bun.YAML.parse(readFileSync(join(dir, 'archon-review-eval-judge.yaml'), 'utf8')) as {
      nodes: { id: string; output_format?: { properties: { defects: { items: { properties: object; required: string[] } } } } }[];
    };
    const schema = workflow.nodes.find(node => node.id === 'judge')?.output_format?.properties.defects.items;
    const stub = Bun.YAML.parse(readFileSync(join(dir, 'fixtures/judge.stubs.yaml'), 'utf8')) as { judge: unknown };
    const judgement = validateJudgement(stub.judge, { ...item, known_defects: [] }, findings);
    if (!judgement.valid) throw new Error(judgement.reason);
    const fields = Object.keys(judgement.defects[0]).sort();
    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual(fields);
    expect([...(schema?.required ?? [])].sort()).toEqual(fields);
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
    const argv = (n: number): unknown => JSON.parse(readFileSync(join(cli, `argv-${n}.json`), 'utf8'));
    /** The judge run `runId` returns `value` as its judgement. */
    const judgeReturns = (runId: string, value: unknown) =>
      writeFileSync(
        join(cli, `detail-${runId}.json`),
        JSON.stringify({ id: runId, status: 'completed', terminal_record: { returns: { availability: 'available', node_id: 'judge', value } } })
      );
    return { repo, out, cli, run, runIn, judge, judgeReturns, argv, packSha };
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
    const artifacts = getRunArtifactsDirForRoot(root, 'run-1');
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
    judgeReturns('run-2', { defects: [{ id: 'D1', caught_by: [], finding: null, excerpt: null, evidence: 'Missed.' }], shape_unmatched: 0 });
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
  it('judges a passed sample from this checkout, and writes its page and unmarked marks', () => {
    const { repo, out, run, argv, judgeReturns } = benchCase({ attention: { kind: 'terminal', status: 'completed' } }, passing);
    const caught = { id: 'D1', caught_by: ['code'], finding: null, excerpt: 'Counts down, not up.', evidence: 'The code lens states it.' };
    judgeReturns('run-2', { defects: [caught], shape_unmatched: 1 });
    expect(run('--variant', 'v1').status).toBe(0);

    const itemDir = join(out, 'items', 'run-1');
    expect(argv(2)).toEqual([
      'workflow',
      'run',
      'archon-review-eval-judge',
      '--cwd',
      realpathSync(repo),
      '--no-worktree',
      '--workflow-source',
      join(import.meta.dir, '../../..'),
      '--input',
      `item=${itemDir}`,
      '--model',
      'large=opus',
      '--detach',
      '--json',
      'Judge which lenses caught each listed defect in this review sample.',
    ]);
    expect(JSON.parse(readFileSync(join(itemDir, 'item.json'), 'utf8'))).toEqual({
      case: 'counting',
      variant: 'v1',
      defects: [{ id: 'D1', class: 'wrong_behaviour', owner: 'code', claim: 'Counts the wrong way.', location: 'a.txt:2' }],
      known_defects: [],
      lenses: { code: 'review/code.md', simplify: 'shape.md' },
    });
    const [judgement] = readLines(join(out, 'judgements.jsonl'));
    expect(judgement).toMatchObject({ run_id: 'run-1', version: 'v', judge_run: 'run-2', valid: true, defects: [caught], shape_unmatched: 1 });
    expect(judgement.judge).toEqual({ spec: 'opus', prompt_sha: expect.stringMatching(/^[0-9a-f]{40}$/) });

    const batch = join(out, 'batches', 'counting');
    const page = readFileSync(join(batch, 'page.md'), 'utf8');
    expect(page.startsWith('# Review-lens batch `counting`')).toBe(true);
    expect(page).toContain('| Caught by | code |');
    expect(page).toContain('| Lens excerpt | Counts down, not up. |');
    expect(page).toContain('| Cost | $1.75 |');
    expect(Bun.YAML.parse(readFileSync(join(batch, 'marks.yaml'), 'utf8'))).toEqual([
      { run_id: 'run-1', version: 'v', variant: 'v1', sample: 1, defect: 'D1', judge: { caught_by: ['code'], finding: null }, mark: null, note: null },
    ]);
  });

  it('judges a spilled return and records an unavailable return as invalid', () => {
    const { out, cli, run } = benchCase({ attention: { kind: 'terminal', status: 'completed' } }, passing);
    const spill = join(out, 'judge-return.json');
    writeFileSync(spill, JSON.stringify({ defects: [{ id: 'D1', caught_by: [], finding: null, excerpt: null, evidence: 'Missed.' }], shape_unmatched: 0 }));
    const returned = (runId: string, returns: unknown) => writeFileSync(join(cli, `detail-${runId}.json`), JSON.stringify({ terminal_record: { returns } }));
    returned('run-2', { availability: 'truncated', spill_path: spill });
    expect(run('--variant', 'v1').status).toBe(0);
    expect(readLines(join(out, 'judgements.jsonl'))[0]).toMatchObject({ valid: true, defects: [{ id: 'D1' }] });

    returned('run-4', { availability: 'unavailable', reason: 'node_failed' });
    expect(run('--variant', 'v1').status).toBe(1);
    expect(readLines(join(out, 'judgements.jsonl'))[1]).toMatchObject({ valid: false, reason: 'run run-4 returned no value: {"availability":"unavailable","reason":"node_failed"}' });
  });

  it('re-judges recorded samples without touching a marked entry, and lists a clean finding to mark', () => {
    const { out, run, judge, judgeReturns } = benchCase({ attention: { kind: 'terminal', status: 'completed' } }, passing);
    judgeReturns('run-2', { defects: [{ id: 'D1', caught_by: ['code'], finding: 'R1', excerpt: null, evidence: 'Stated.' }], shape_unmatched: 0 });
    expect(run('--variant', 'v1').status).toBe(0);
    // The same run detail answers for the clean sample, which has nothing planted to judge.
    judgeReturns('run-4', { defects: [], shape_unmatched: 0 });
    expect(run('--variant', 'clean').status).toBe(0);

    const marks = join(out, 'batches', 'counting', 'marks.yaml');
    const [defect, finding] = Bun.YAML.parse(readFileSync(marks, 'utf8')) as Record<string, unknown>[];
    expect(finding).toEqual({ run_id: 'run-3', version: 'v', variant: 'clean', sample: 1, finding: 'R1', sources: ['code'], claim: 'Unrelated.', mark: null, note: null });
    const marked = { ...defect, mark: 'wrong', caught_by: [], note: 'R1 is about another line.' };
    writeFileSync(marks, Bun.YAML.stringify([marked, finding], null, 2));

    judgeReturns('run-5', { defects: [{ id: 'D1', caught_by: [], finding: null, excerpt: null, evidence: 'Not stated.' }], shape_unmatched: 0 });
    judgeReturns('run-6', { defects: [], shape_unmatched: 0 });
    expect(judge('--batch', 'counting').status).toBe(0);
    const judged = readLines(join(out, 'judgements.jsonl')).map(line => `${String(line.run_id)} by ${String(line.judge_run)}`);
    expect(judged.sort()).toEqual(['run-1 by run-2', 'run-1 by run-5', 'run-3 by run-4', 'run-3 by run-6']);
    expect(Bun.YAML.parse(readFileSync(marks, 'utf8'))).toEqual([marked, finding]);
    expect(readFileSync(join(out, 'batches', 'counting', 'page.md'), 'utf8')).toContain('| Evidence | Not stated. |');
  });

  it('renders a damaged saved item as invalid and refreshes the other batches', () => {
    const { out, judge, judgeReturns } = benchCase({ attention: { kind: 'terminal', status: 'completed' } });
    for (const [caseId, runId] of [['damaged', 'bad-run'], ['healthy', 'good-run']]) {
      const dir = join(out, 'items', runId);
      write(dir, 'item.json', caseId === 'damaged' ? '{' : JSON.stringify({ case: caseId, variant: 'clean', defects: [], known_defects: [], lenses: {} }));
      write(dir, 'review/findings.json', '[]');
      appendLine(join(out, 'samples.jsonl'), { case: caseId, variant: 'clean', sample: 1, run_id: runId, version: { label: 'v' }, passed: true, item: join('items', runId) });
    }
    judgeReturns('run-1', { defects: [], shape_unmatched: 0 });
    const result = judge();
    expect(result.status).toBe(1);
    expect(readLines(join(out, 'judgements.jsonl'))).toContainEqual(expect.objectContaining({ run_id: 'bad-run', valid: false }));
    expect(readFileSync(join(out, 'batches', 'damaged', 'page.md'), 'utf8')).toContain('| Judgement | invalid:');
    expect(Bun.YAML.parse(readFileSync(join(out, 'batches', 'damaged', 'marks.yaml'), 'utf8'))).toEqual([]);
    expect(readFileSync(join(out, 'batches', 'healthy', 'page.md'), 'utf8')).toContain('| Judgement | valid |');
    expect(existsSync(join(out, 'batches', 'healthy', 'marks.yaml'))).toBe(true);
  });

  it('heads the page FAILED and judges nothing when a sample fails a hard check', () => {
    const unreadable = (root: string) => {
      const detail = passing(root);
      write(getRunArtifactsDirForRoot(root, 'run-1'), 'review/findings.json', JSON.stringify([{ id: 'R1', severity: 'note', claim: 'No sources.', status: 'open' }]));
      return detail;
    };
    const { out, cli, run } = benchCase({ attention: { kind: 'terminal', status: 'completed' } }, unreadable);
    expect(run('--variant', 'v1').status).toBe(1);
    expect(existsSync(join(cli, 'argv-2.json'))).toBe(false);

    const batch = join(out, 'batches', 'counting');
    const page = readFileSync(join(batch, 'page.md'), 'utf8');
    expect(page.startsWith('FAILED: 1 sample(s) failed a hard check')).toBe(true);
    expect(page).toContain('`v #1` v1 (run run-1): output: review/findings.json does not read:');
    expect(page).toContain('| Judgement | not judged: hard checks failed |');
    expect(Bun.YAML.parse(readFileSync(join(batch, 'marks.yaml'), 'utf8'))).toEqual([]);
  });

  it('records a judgement that credits a lens with no output as invalid, and leaves nothing to mark', () => {
    const { out, run, judgeReturns } = benchCase({ attention: { kind: 'terminal', status: 'completed' } }, passing);
    judgeReturns('run-2', { defects: [{ id: 'D1', caught_by: ['docs'], finding: null, excerpt: null, evidence: 'Docs.' }], shape_unmatched: 0 });
    const { status, stderr } = run('--variant', 'v1');
    expect(status).toBe(1);
    expect(stderr).toContain('judgement invalid: defect D1: lens docs left no output in this sample');
    expect(readLines(join(out, 'judgements.jsonl'))).toMatchObject([{ run_id: 'run-1', valid: false, reason: 'defect D1: lens docs left no output in this sample' }]);
    expect(readFileSync(join(out, 'batches', 'counting', 'page.md'), 'utf8')).toContain('| Judgement | invalid: defect D1: lens docs left no output in this sample |');
    expect(Bun.YAML.parse(readFileSync(join(out, 'batches', 'counting', 'marks.yaml'), 'utf8'))).toEqual([]);
  });
});
