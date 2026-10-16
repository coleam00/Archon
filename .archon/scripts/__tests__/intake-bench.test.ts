/**
 * The intake bench's own invariants, each one whose failure would silently corrupt its
 * numbers or its trust proof: a version that cannot be pinned, a run judged on text
 * other than the pinned creation text, an unlabelled line, a write or an outside
 * agent that does not fail its batch, a stale or leaked line counted, and marks that
 * do not tally across batches.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { providerRegistry } from '@archon/providers';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import { expandWorkflowIncludes } from '../../../packages/workflows/src/include-expander';
import { parseWorkflow } from '../../../packages/workflows/src/loader';
import { validateStructuredOutput } from '../../../packages/workflows/src/structured-output';
import type { WorkflowDefinition } from '../../../packages/workflows/src/schemas';
import { type RunDetail, SAMPLES_FILE, appendLine, readLines, returnedValue } from '../../workflows/sdlc/.shared/bench';
import { postMark, renderPage } from '../../workflows/sdlc/intake/scripts/bench/page';
import {
  type BatchChecks,
  batchChecks,
  bindingStubs,
  CHECKS_FILE,
  checkScratch,
  loadLive,
  findLeaks,
  issueTokens,
  type Line,
  postedComments,
  runCost,
  runBatch,
  type Snapshot,
  snapshotChanges,
  toVerdict,
  triageNodeId,
  TRIAGE_VERDICT_NODE,
  type Version,
} from '../../workflows/sdlc/intake/scripts/bench/runner';
import { MARKS_FILE, closeCheck, renderScore, score } from '../../workflows/sdlc/intake/scripts/bench/score';
import {
  type BenchSet,
  humanType,
  orderRows,
  parseDispositions,
  type Row,
  toCandidate,
} from '../../workflows/sdlc/intake/scripts/bench/set';
import { type FakeConfig, install } from './fake-intake-bench-cli';

const track = trackTempRoots();
const REPO = { host: 'github.com', path: 'o/r' };
const SCRIPT = join(import.meta.dir, '../../workflows/sdlc/intake/scripts/bench/bench.ts');
const FAKE = join(import.meta.dir, 'fake-intake-bench-cli.ts');
// The fake answers `gh`, so issue reads must not go through the default forge plugin.
const GH_FORGE = { ...process.env, ARCHON_SDLC_FORGE: 'gh' };

function ok(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function write(root: string, path: string, content: string): void {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), content);
}

function row(number: number, overrides: Partial<Row> = {}): Row {
  return {
    id: String(number),
    number,
    group: 'duplicate',
    workflow: 'triage',
    trust: 'auto',
    author: 'someone',
    title: `Issue ${String(number)} as opened`,
    body: `The body ${String(number)} was opened with.`,
    body_from: 'creation',
    known: {},
    ...overrides,
  };
}

describe('selection', () => {
  it('reads a duplicate canonical and only a merged closing pull request', () => {
    const node = (closer: unknown, duplicateOf: unknown = null) => ({
      number: 7,
      author: { login: 'a' },
      labels: { nodes: [{ name: 'bug' }] },
      timelineItems: { nodes: [{ duplicateOf, closer }] },
    });
    expect(toCandidate(node({ url: 'https://github.com/o/r/pull/9', merged: true }))?.closedBy).toBe('https://github.com/o/r/pull/9');
    expect(toCandidate(node({ url: 'https://github.com/o/r/pull/9', merged: false }))?.closedBy).toBeNull();
    expect(toCandidate(node(null, { url: 'https://github.com/o/r/issues/3' }))?.duplicateOf).toBe('https://github.com/o/r/issues/3');
  });

  it('reads enhancement and feature as one type, and conflicting type labels as none', () => {
    expect(humanType(['enhancement', 'area: cli'])).toBe('feature');
    expect(humanType(['enhancement', 'feature'])).toBe('feature');
    expect(humanType(['bug', 'enhancement'])).toBeUndefined();
    expect(humanType(['archon-type-bug'])).toBeUndefined();
  });

  it('mixes groups in every batch and keeps each trust: outside row beside its source', () => {
    const rows = [
      row(1, { group: 'duplicate' }),
      row(2, { group: 'duplicate' }),
      row(3, { group: 'fixed', workflow: 'intake' }),
      row(3, { id: '3-outside', group: 'fixed', workflow: 'intake', trust: 'outside' }),
      row(4, { group: 'not_planned' }),
    ];
    expect(orderRows(rows).map(entry => entry.id)).toEqual(['1', '3', '3-outside', '4', '2']);
  });

  it('refuses a disposition whose route does not belong to its contract', () => {
    const dir = track(mkdtempSync(join(tmpdir(), 'intake-bench-')));
    writeFileSync(join(dir, 'd.json'), JSON.stringify([{ number: 5, contract: 'BLOCKED', route: 'plan' }]));
    expect(() => parseDispositions(join(dir, 'd.json'))).toThrow('only a READY disposition names a route');
    writeFileSync(join(dir, 'd.json'), JSON.stringify([{ number: 5, contract: 'READY', route: 'plan', note: 'n' }]));
    expect(parseDispositions(join(dir, 'd.json')).get(5)).toEqual({ contract: 'READY', route: 'plan', note: 'n' });
  });
});

describe('bench run', () => {
  /**
   * `bench.ts run` over a two-row batch in a fresh repository, with the fake
   * `archon` and `gh` of ./fake-intake-bench-cli.ts. Row 11 is an outside author's,
   * judged by archon-triage; row 12-outside is a maintainer's run through intake as
   * an outside author's.
   */
  function bench(scenario: Partial<FakeConfig> = {}) {
    const repo = track(mkdtempSync(join(tmpdir(), 'intake-bench-repo-')));
    ok(repo, 'init', '-q', '-b', 'dev');
    ok(repo, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
    write(repo, '.archon/workflows/sdlc/triage/archon-triage.yaml', 'name: archon-triage\nmodel: medium\n');
    write(repo, '.archon/workflows/sdlc/triage/commands/triage.md', 'Triage.\n');
    write(
      repo,
      '.archon/workflows/sdlc/triage/fixtures/deliver.stubs.yaml',
      'triage:\n  decision: { contract: READY, route: deliver }\nfixture:\n  expect: completed\nexec-code: true\n'
    );
    write(repo, '.archon/workflows/sdlc/intake/archon-intake.yaml', 'name: archon-intake\n');
    ok(repo, 'add', '-A');
    ok(repo, 'commit', '-q', '-m', 'pack');
    const packSha = ok(repo, 'rev-parse', 'HEAD');

    const out = track(mkdtempSync(join(tmpdir(), 'intake-bench-out-')));
    const set: BenchSet = {
      bench: 'intake',
      repo: REPO,
      selected_at: '2026-10-15T00:00:00Z',
      rows: [row(11, { known: { canonical: 'https://github.com/o/r/issues/9' } }), row(12, { id: '12-outside', group: 'fixed', workflow: 'intake', trust: 'outside', author: 'Maintainer' })],
    };
    writeFileSync(join(out, 'set.json'), JSON.stringify(set));
    writeFileSync(join(out, 'base.yaml'), `label: base\npack_sha: ${packSha}\n`);
    writeFileSync(join(out, 'haiku.yaml'), `label: haiku\npack_sha: ${packSha}\nprovider: claude\nmodel: claude-haiku-5-5\n`);

    const cli = track(mkdtempSync(join(tmpdir(), 'intake-bench-cli-')));
    const config: FakeConfig = {
      baseline: { provider: 'codex', model: 'gpt-x', effort: 'medium' },
      repo: REPO,
      issues: [
        { number: 11, labels: [], comments: 0 },
        { number: 9, labels: [], comments: 0 },
        { number: 12, labels: ['bug'], comments: 2 },
      ],
      projectKey: 'o/r',
      ...scenario,
    };
    writeFileSync(join(cli, 'config.json'), JSON.stringify(config));
    const preload = join(cli, 'preload.ts');
    writeFileSync(preload, `import { install } from ${JSON.stringify(FAKE)};\ninstall(${JSON.stringify(cli)});\n`);
    const run = (...versions: string[]) => runWith([], ...versions);
    const runWith = (extra: string[], ...versions: string[]) => {
      const result = spawnSync(
        process.execPath,
        [
          '--preload',
          preload,
          SCRIPT,
          'run',
          '--set',
          join(out, 'set.json'),
          '--batch',
          '1',
          ...versions.flatMap(version => ['--version', join(out, `${version}.yaml`)]),
          '--out',
          join(out, 'bench'),
          ...extra,
        ],
        { cwd: repo, encoding: 'utf8' }
      );
      return {
        status: result.status,
        stderr: result.stderr,
        lines: readLines(join(out, 'bench', SAMPLES_FILE)) as unknown as Line[],
        checks: readLines(join(out, 'bench', CHECKS_FILE)) as unknown as BatchChecks[],
      };
    };
    const argv = (n: number): string[] => JSON.parse(readFileSync(join(cli, `argv-${n}.json`), 'utf8'));
    const setBaseline = (baseline: FakeConfig['baseline']): void =>
      writeFileSync(join(cli, 'config.json'), JSON.stringify({ ...config, baseline }));
    return { run, runWith, argv, packSha, setBaseline, repo, out, cli };
  }

  it('judges each row on its pinned text with each version, and labels every line', () => {
    const { run, argv, packSha } = bench();
    const { status, stderr, lines, checks } = run('base', 'haiku');
    expect(stderr).toBe('');
    expect(status).toBe(0);

    const launched = [1, 2, 3, 4].map(argv);
    const triageRun = launched.find(args => args[2] === 'archon-triage');
    expect(triageRun).toContain('target=# Issue 11 as opened\n\nThe body 11 was opened with.');
    expect(triageRun).toContain('publish=false');
    const intakeRun = launched.find(args => args[2] === 'archon-intake');
    expect(intakeRun).toEqual(expect.arrayContaining(['mode=eval', 'trust=outside', 'number=12', '--no-worktree']));

    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect(line.version.pack_sha).toBe(packSha);
      expect(line.version.tier).toBe('medium');
      expect(line.passed).toBe(true);
    }
    const versions = Object.fromEntries(lines.map(line => [line.version.label, line.version] as const));
    expect(versions.base).toMatchObject({ provider: 'codex', model: 'gpt-x', effort: 'medium' });
    // Only the model moves: the baseline's effort stays.
    expect(versions.haiku).toMatchObject({ provider: 'claude', model: 'claude-haiku-5-5', effort: 'medium' });
    const triaged = lines.find(line => line.row === '11' && line.version.label === 'haiku');
    expect([triaged?.workflow, triaged?.verdict?.contract, triaged?.verdict?.route, triaged?.verdict?.blocked_by]).toEqual([
      'triage',
      'BLOCKED',
      null,
      ['https://github.com/o/r/issues/1'],
    ]);
    expect([triaged?.agent_nodes, triaged?.cost_usd]).toEqual([['triage'], 0.5]);
    // The skipped judge's empty binding proves nothing and fails nothing.
    expect(lines.find(line => line.row === '12-outside')).toMatchObject({ agent_nodes: [], binding: null, verdict: null, cost_usd: 0 });
    expect(checks).toHaveLength(1);
    expect(checks[0].passed).toBe(true);
  });

  it('resolves each version on its own pack fixture, with the fixture keys left out', () => {
    const { run, out } = bench();
    expect(run('base').status).toBe(0);
    expect(Bun.YAML.parse(readFileSync(join(out, 'bench', 'versions', 'base.stubs.yaml'), 'utf8'))).toEqual({
      triage: { decision: { contract: 'READY', route: 'deliver' } },
    });
  });

  it('gives every run its own worktree of the operator checkout, so concurrent runs share none', () => {
    const { runWith, argv, repo } = bench();
    const { status, stderr } = runWith(['--concurrency', '4'], 'base', 'haiku');
    expect([status, stderr]).toEqual([0, '']);
    const cwds = [1, 2, 3, 4].map(n => {
      const args = argv(n);
      return args[args.indexOf('--cwd') + 1];
    });
    expect(new Set(cwds).size).toBe(4);
    // A worktree resolves to the project registered for the operator checkout; a clone would be a second one.
    const worktrees = ok(repo, 'worktree', 'list', '--porcelain')
      .split('\n')
      .filter(line => line.startsWith('worktree '))
      .map(line => realpathSync(line.slice('worktree '.length)));
    for (const cwd of cwds) expect(worktrees).toContain(realpathSync(cwd));
  });

  it('fails the batch when a run is cancelled', () => {
    const { status, stderr, lines, checks } = bench({ runStatus: 'cancelled' }).run('base');
    expect(status).toBe(1);
    expect(stderr).toContain('FAILED its hard checks');
    expect(lines.map(line => line.status)).toEqual(['cancelled', 'cancelled']);
    expect(checks[0].checks.finished).toEqual({
      ok: false,
      problems: ['base 11: the run is cancelled', 'base 12-outside: the run is cancelled'],
    });
  });

  it('fails the batch when a run fails before any node starts, and not when its agent ran and failed', () => {
    const launch = bench({ launchFails: true }).run('base');
    expect([launch.status, launch.checks[0].checks.finished.ok]).toEqual([1, false]);
    expect(launch.checks[0].checks.finished.problems).toEqual([expect.stringContaining('base 11: '), expect.stringContaining('base 12-outside: ')]);
    // Row 11's judge ran and the run failed: its version's result. The outside row's run failed with no agent run.
    const ran = bench({ runStatus: 'failed' }).run('base');
    expect(ran.lines.find(line => line.row === '11')?.passed).toBe(false);
    expect(ran.checks[0].checks.finished.problems).toEqual(['base 12-outside: the run is failed']);
  });

  it('refuses before any run when a version cannot be resolved', () => {
    const { run } = bench({ baseline: null });
    const { status, stderr, lines } = run('base');
    expect(status).toBe(1);
    expect(stderr).toContain('resolved no provider and model');
    expect(lines).toEqual([]);
  });

  it('refuses a label already recorded with another version', () => {
    const { run, setBaseline } = bench();
    expect(run('base').status).toBe(0);
    expect(run('base').status).toBe(0);
    setBaseline({ provider: 'codex', model: 'gpt-y', effort: 'medium' });
    const { status, stderr, lines } = run('base');
    expect(status).toBe(1);
    expect(stderr).toContain('label base already names another version');
    expect(lines).toHaveLength(4);
  });

  it('refuses a label that is not a plain id before building any checkout path', () => {
    const { run, out } = bench();
    writeFileSync(join(out, 'escape.yaml'), 'label: ../escape\n');
    const { status, stderr } = run('escape');
    expect(status).toBe(1);
    expect(stderr).toContain('`label` must be letters, digits');
    expect(existsSync(join(out, 'bench', 'escape'))).toBe(false);
  });

  it('names the file when a version file is empty', () => {
    const { run, out } = bench();
    writeFileSync(join(out, 'empty.yaml'), '');
    const { status, stderr } = run('empty');
    expect(status).toBe(1);
    expect(stderr).toContain('empty.yaml');
    expect(stderr).toContain('`label` must be letters, digits');
  });

  /** `run --live` for the base version on a scratch clone holding copies 101 and 102 of the two rows. */
  function benchLive(scenario: Partial<FakeConfig> = {}, defaultBranch: 'base' | 'empty' | 'other' | 'ambiguous' = 'base', canonical = 'https://github.com/o/r/issues/9') {
    const { runWith, argv, repo, out, cli, packSha } = bench(scenario);
    const scratch = track(mkdtempSync(join(tmpdir(), 'intake-bench-scratch-')));
    ok(scratch, 'clone', '-q', repo, '.');
    ok(repo, 'commit', '-q', '--allow-empty', '-m', 'after the batch base');
    ok(scratch, 'remote', 'set-url', 'origin', 'git@github.com:me/scratch-base.git');
    const remote = track(mkdtempSync(join(tmpdir(), 'intake-bench-remote-')));
    if (defaultBranch === 'empty') ok(remote, 'init', '-q', '--bare');
    else ok(remote, 'clone', '-q', '--bare', defaultBranch === 'other' ? repo : scratch, '.');
    ok(scratch, 'config', `url.${remote}.insteadOf`, 'git@github.com:me/scratch-base.git');
    if (defaultBranch === 'ambiguous') ok(scratch, 'remote', 'add', 'mirror', 'git@github.com:me/scratch-base.git');
    const set = JSON.parse(readFileSync(join(out, 'set.json'), 'utf8')) as BenchSet;
    writeFileSync(join(out, 'set.json'), JSON.stringify({ ...set, rows: set.rows.map(row => row.id === '11' ? { ...row, known: { canonical } } : row) }));
    writeFileSync(join(out, 'live.yaml'), JSON.stringify({ base: { repo: { host: 'github.com', path: 'me/scratch-base' }, checkout: scratch } }));
    mkdirSync(join(out, 'bench', 'live'), { recursive: true });
    writeFileSync(join(out, 'bench', 'live', 'base.json'), JSON.stringify({ repo: { host: 'github.com', path: 'me/scratch-base' }, copies: { '11': 101, '12-outside': 102, [`canonical:${canonical}`]: 103 } }));
    const config = JSON.parse(readFileSync(join(cli, 'config.json'), 'utf8')) as FakeConfig;
    for (const number of [9, 101, 102, 103]) {
      if (!config.issues.some(issue => issue.number === number)) config.issues.push({ number, labels: [], comments: 0 });
    }
    for (const [index, issue] of config.issues.entries()) {
      if ([101, 102, 103].includes(issue.number)) config.issues[index] = { ...issue, repo: { host: 'github.com', path: 'me/scratch-base' } };
    }
    writeFileSync(join(cli, 'config.json'), JSON.stringify(config));
    return { ...runWith(['--live', join(out, 'live.yaml'), '--base', packSha], 'base'), argv, scratch, remote, packSha };
  }

  it('refuses a missing default branch or one away from the base before launching', () => {
    for (const branch of ['empty', 'other'] as const) {
      const result = benchLive({}, branch);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(branch === 'empty' ? 'no default branch' : 'not the batch base');
      expect(result.stderr).toContain('git push');
      expect(result.lines).toEqual([]);
      expect(() => result.argv(1)).toThrow();
      const target = `bench-${result.packSha.slice(0, 12)}`;
      expect(result.stderr).toContain(`git push origin ${result.packSha}:refs/heads/${target}`);
      ok(result.scratch, 'push', 'origin', `${result.packSha}:refs/heads/${target}`);
      ok(result.remote, 'symbolic-ref', 'HEAD', `refs/heads/${target}`);
      expect(() => checkScratch('base', { repo: { host: 'github.com', path: 'me/scratch-base' }, checkout: result.scratch }, result.packSha)).not.toThrow();
    }
  });

  it('refuses ambiguous scratch remotes before launching', () => {
    const result = benchLive({}, 'ambiguous');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ambiguous');
    expect(result.lines).toEqual([]);
    expect(() => result.argv(1)).toThrow();
  });

  it('refuses missing scratch remotes and git configuration read failures', () => {
    const checkout = track(mkdtempSync(join(tmpdir(), 'intake-bench-scratch-')));
    ok(checkout, 'init', '-q');
    const scratch = { repo: { host: 'github.com', path: 'me/scratch-base' }, checkout };
    expect(() => checkScratch('base', scratch, '0'.repeat(40))).toThrow('no git remote points at');
    writeFileSync(join(checkout, '.git/config'), '[broken');
    expect(() => checkScratch('base', scratch, '0'.repeat(40))).toThrow('git config --get-regexp failed');
  });

  it('runs with an already copied external canonical without reading its repository', () => {
    const result = benchLive({ unavailableRepos: ['github.com/other/repo'] }, 'base', 'https://github.com/other/repo/issues/9');
    expect([result.status, result.stderr, result.checks[0]?.passed]).toEqual([0, '', true]);
    expect(result.lines).toHaveLength(2);
  });

  it.each([false, true])('copies external canonical creation text alongside unchanged duplicates and resumes (edited: %s)', edited => {
    const { repo, out, cli } = bench({ issues: [
      { number: 9, labels: [], comments: 0, title: 'Wrong repository title', body: 'Wrong repository body', creation: { title: 'Wrong creation title', body: 'Wrong creation body' } },
      { number: 9, repo: { host: 'github.com', path: 'other/repo' }, labels: [], comments: 7, title: edited ? 'Edited title' : 'Original title', body: edited ? 'Edited body' : 'Original body', ...(edited ? { creation: { title: 'Original title', body: 'Original body' } } : {}) },
    ] });
    const canonical = 'https://github.com/other/repo/issues/9';
    const rows = [row(11, { known: { canonical } }), row(12, { known: { canonical } })];
    writeFileSync(join(out, 'set.json'), JSON.stringify({ bench: 'intake', repo: REPO, selected_at: '', rows }));
    writeFileSync(join(out, 'live.yaml'), JSON.stringify({ base: { repo: { host: 'github.com', path: 'me/scratch-base' }, checkout: repo } }));
    const copy = (directory = 'bench') => spawnSync(process.execPath, ['--preload', join(cli, 'preload.ts'), SCRIPT, 'copy', '--set', join(out, 'set.json'), '--batch', '1', '--live', join(out, 'live.yaml'), '--out', join(out, directory)], { cwd: repo, encoding: 'utf8' });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = copy();
      expect([result.status, result.stderr]).toEqual([0, '']);
    }
    const created = JSON.parse(readFileSync(join(cli, 'created.json'), 'utf8')) as { endpoint: string; title: string; body: string }[];
    expect(created).toHaveLength(3);
    expect(created.every(issue => issue.endpoint === 'repos/me/scratch-base/issues')).toBe(true);
    expect(created.map(({ title, body }) => ({ title, body }))).toEqual(expect.arrayContaining([
      { title: 'Original title', body: 'Original body' },
      ...rows.map(({ title, body }) => ({ title, body })),
    ]));
    const config = JSON.parse(readFileSync(join(cli, 'config.json'), 'utf8')) as FakeConfig;
    config.issues[1] = { ...config.issues[1], creation: null };
    writeFileSync(join(cli, 'config.json'), JSON.stringify(config));
    const unavailable = copy('unavailable');
    expect(unavailable.status).toBe(1);
    expect(unavailable.stderr).toContain('creation text is unavailable');
    expect(JSON.parse(readFileSync(join(cli, 'created.json'), 'utf8'))).toHaveLength(3);
  });

  it('allows only the exact declared closure comments on scratch issues, including canonical backlinks', async () => {
    const dir = track(mkdtempSync(join(tmpdir(), 'intake-bench-comments-')));
    const scratchRepo = { host: 'github.com', path: 'me/scratch-base' };
    const version: Version = { label: 'base', pack_sha: 'base', prompt_sha: { triage: 'prompt' }, provider: 'codex', model: 'gpt-x', tier: 'medium' };
    const baseline = { provider: version.provider, model: version.model };
    const config = join(dir, 'binding.yaml');
    writeFileSync(config, Bun.YAML.stringify({ tiers: { medium: baseline } }));
    const rows = [row(11, { known: { canonical: 'https://github.com/o/r/issues/9' } }), row(12, { id: '12-outside', workflow: 'intake', trust: 'outside' })];
    const run = async (scenario: Partial<FakeConfig>) => {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({
        baseline, repo: REPO, projectKey: 'o/r',
        issues: [
          ...[9, 11, 12].map(number => ({ number, labels: [], comments: 0 })),
          ...[101, 102, 103].map(number => ({ number, repo: scratchRepo, labels: [], comments: 0 })),
        ],
        ...scenario,
      } satisfies FakeConfig));
      return runBatch({
        set: { bench: 'intake', repo: REPO, selected_at: '2026-10-15T00:00:00Z', rows },
        rows, batch: 1, base: 'base', outDir: dir, repoRoot: dir,
        versions: [{ resolved: { version, source: dir, config }, checkout: () => dir }],
        live: new Map([['base', { scratch: { repo: scratchRepo, checkout: dir }, copies: { '11': 101, '12-outside': 102, 'canonical:https://github.com/o/r/issues/9': 103 } }]]),
      });
    };
    const { spawn, spawnSync } = Bun;
    install(dir);
    try {
      const delivered = { kind: 'delivered' as const, url: 'https://github.com/o/r/pull/30' };
      const duplicate = { kind: 'duplicate' as const, url: 'https://github.com/me/scratch-base/issues/103', original: { repo: { host: 'github.com', path: 'me/scratch-base' }, number: 103 } };
      for (const declaredClosure of [delivered, duplicate,
        { ...duplicate, original: { ...duplicate.original, repo: { host: 'GITHUB.COM', path: 'me/scratch-base' } } },
        { ...duplicate, original: { ...duplicate.original, repo: { host: 'github.com', path: 'Me/Scratch-Base' } } },
      ]) {
        const closingUrl = declaredClosure.kind === 'delivered' ? declaredClosure.url : `https://github.com/${declaredClosure.original.repo.path}/issues/103`;
        const posted = declaredClosure.kind === 'delivered'
          ? [{ number: 101, body: `<!-- archon-close -->\nClosing as already delivered by ${declaredClosure.url}.` }]
          : [
              { number: 101, body: `<!-- archon-close -->\nClosing as a duplicate of ${closingUrl}; follow the work there.` },
              { number: 103, body: '<!-- archon-duplicate github.com/me/scratch-base#101 -->\nhttps://github.com/me/scratch-base/issues/101 was closed as a duplicate of this issue.' },
            ];
        const allowed = await run({ declaredClosure, posted });
        expect([allowed.checks.passed, allowed.checks.checks.posted_text.ok]).toEqual([true, true]);
        const failed = await run({ declaredClosure, posted, runStatus: 'failed' });
        expect(failed.checks.checks.posted_text.ok).toBe(true);
        const undeclared = await run({ posted });
        expect(undeclared.checks.checks.posted_text.ok).toBe(false);
        const altered = [`${posted[0].body}\nExtra text`, posted[0].body.replace(closingUrl, 'https://github.com/o/r/issues/999')];
        for (const changed of [
          [...posted, { number: 101, body: 'Unrelated text' }],
          ...altered.map(body => [{ ...posted[0], body }, ...posted.slice(1)]),
        ]) {
          const rejected = await run({ declaredClosure, posted: changed });
          expect([rejected.checks.passed, rejected.checks.checks.posted_text.ok]).toEqual([false, false]);
        }
      }
    } finally {
      Object.assign(Bun, { spawn, spawnSync });
    }
  });

  it('rejects declared closure text when the recorded verdict is READY', () => {
    const declaredClosure = { kind: 'delivered' as const, url: 'https://github.com/o/r/pull/30' };
    const posted = [{ number: 101, body: `<!-- archon-close -->\nClosing as already delivered by ${declaredClosure.url}.` }];
    for (const runStatus of [undefined, 'failed'] as const) {
      const result = benchLive({ declaredClosure, posted, recordedContract: 'READY', runStatus });
      expect([result.status, result.checks[0]?.checks.posted_text.ok]).toEqual([1, false]);
    }
  });

  it('uses the forge canonical URL spelling, as the closure writer does', () => {
    const url = 'https://github.com/Me/Scratch-Base/issues/103';
    const declaredClosure = { kind: 'duplicate' as const, url: url.toLowerCase(), original: { repo: { host: 'github.com', path: 'me/scratch-base' }, number: 103 } };
    const result = benchLive({ issues: [9, 11, 12, 103].map(number => ({ number, labels: [], comments: 0, ...(number === 103 ? { url } : {}) })), declaredClosure, posted: [{ number: 101, body: `<!-- archon-close -->\nClosing as a duplicate of ${url}; follow the work there.` }] });
    expect(result.checks[0].checks.posted_text.ok).toBe(true);
  });

  it('rejects closure backlinks on the source canonical and unrelated text on a scratch canonical', () => {
    const declaredClosure = { kind: 'duplicate' as const, url: 'https://github.com/o/r/issues/9', original: { repo: REPO, number: 9 } };
    const result = benchLive({ declaredClosure, posted: [{ number: 9, body: '<!-- archon-duplicate github.com/me/scratch-base#101 -->\nhttps://github.com/me/scratch-base/issues/101 was closed as a duplicate of this issue.' }] });
    expect(result.checks[0].checks.writes.ok).toBe(false);
    expect(result.checks[0].checks.posted_text.problems).toEqual([
      expect.stringContaining('not the row\'s mapped scratch canonical'),
      expect.stringContaining('github.com/o/r#9'),
    ]);
    const scratch = benchLive({ posted: [{ number: 103, body: 'Unrelated text' }] });
    expect(scratch.checks[0].checks.posted_text.problems).toEqual([expect.stringContaining('github.com/me/scratch-base#103')]);
  });

  it('rejects duplicate destinations outside the row mapped canonical', () => {
    for (const repo of [REPO, { host: 'github.com', path: 'me/scratch-base' }, { host: 'github.com', path: 'other/repo' }]) {
      const number = 77;
      const url = `https://${repo.host}/${repo.path}/issues/${number}`;
      const result = benchLive({
        issues: [...[9, 11, 12].map(number => ({ number, labels: [], comments: 0 })), { number, repo, labels: [], comments: 0 }],
        declaredClosure: { kind: 'duplicate', url, original: { repo, number } },
        posted: [
          { number: 101, body: `<!-- archon-close -->\nClosing as a duplicate of ${url}; follow the work there.` },
          { number, body: '<!-- archon-duplicate github.com/me/scratch-base#101 -->\nhttps://github.com/me/scratch-base/issues/101 was closed as a duplicate of this issue.' },
        ],
      });
      expect([repo.path, result.status, result.checks[0]?.checks.posted_text.ok]).toEqual([repo.path, 1, false]);
      if (repo.path === REPO.path) expect(result.checks[0].checks.writes.ok).toBe(false);
    }
  });

  it('detects independent comments on unlisted source and scratch issues', () => {
    for (const repo of [REPO, { host: 'github.com', path: 'me/scratch-base' }]) {
      const result = benchLive({
        issues: [...[9, 11, 12, ...Array.from({ length: 100 }, (_, i) => i + 200)].map(number => ({ number, repo: REPO, labels: [], comments: 0 })), { number: 77, repo, labels: [], comments: 0 }],
        posted: [{ number: 77, body: 'Unlisted write' }],
      });
      expect([result.status, result.checks[0]?.checks.posted_text.ok]).toEqual([1, false]);
      if (repo.path === REPO.path) expect(result.checks[0].checks.writes.ok).toBe(false);
    }
  });

  it('leaves independent posts to other repositories outside the monitored check', () => {
    const result = benchLive({
      issues: [...[9, 11, 12].map(number => ({ number, labels: [], comments: 0 })), { number: 77, repo: { host: 'github.com', path: 'other/repo' }, labels: [], comments: 0 }],
      posted: [{ number: 77, body: 'Outside the monitored repositories' }],
    });
    expect([result.status, result.checks[0]?.checks.posted_text.ok]).toEqual([0, true]);
  });

  it('checks comments beyond the first page', () => {
    const issues = [9, 11, 12, 101].map(number => ({ number, labels: [], comments: number === 101 ? 100 : 0 }));
    const result = benchLive({ issues, posted: [{ number: 101, body: 'Unexpected comment on page two' }] });
    expect(result.checks[0].checks.posted_text.ok).toBe(false);
  });

  it('records original merged-base evidence in live scratch runs for scoring', () => {
    const { status, lines, argv } = benchLive({ issues: [
      { number: 11, labels: [], comments: 0, refs: [
        { url: 'https://github.com/o/r/pull/30', merged: true, oid: 'HEAD~1' },
        { connected: true, url: 'https://github.com/o/r/pull/31', merged: true, oid: 'HEAD~1' },
        { url: 'https://github.com/o/r/pull/32', merged: true, oid: 'HEAD' },
        { url: 'https://github.com/o/r/pull/33', merged: false, oid: null },
        { url: 'https://github.com/fork/r/pull/34', merged: true, oid: 'f'.repeat(40) },
      ] },
      { number: 12, labels: [], comments: 0 },
    ] });
    expect(status).toBe(0);
    expect(lines.find(line => line.row === '11')?.merged_on_base).toEqual(['https://github.com/o/r/pull/30', 'https://github.com/o/r/pull/31']);
    expect(argv(1)).toContain('mode=live');
  });

  it('runs intake live on the version scratch copies and reads the verdict from the copy work item', () => {
    const { status, stderr, lines, checks, argv, scratch } = benchLive();
    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(argv(1)).toEqual(expect.arrayContaining(['archon-intake', scratch, 'repo_path=me/scratch-base', 'number=101', 'mode=live', 'trust=auto']));
    // Row 11 is pinned to archon-triage; live, it runs through intake and is proven on intake's judge.
    const live = lines.find(line => line.row === '11');
    expect([live?.mode, live?.workflow, live?.verdict?.contract, live?.verdict?.route, live?.verdict?.summary]).toEqual(['live', 'intake', 'READY', 'plan', undefined]);
    expect(lines.map(line => [line.row, line.passed, line.problems])).toEqual([
      ['11', true, []],
      ['12-outside', true, []],
    ]);
    expect(checks[0]).toMatchObject({ mode: 'live', passed: true });
  });

  it('fails live rows when original merged-base evidence is incomplete', () => {
    const refs = Array.from({ length: 101 }, (_, i) => ({ url: `https://github.com/o/r/pull/${String(i)}`, merged: false, oid: null }));
    const { status, lines, argv } = benchLive({ issues: [{ number: 11, labels: [], comments: 0, refs }, { number: 12, labels: [], comments: 0 }] });
    expect(status).toBe(1);
    expect(lines.find(line => line.row === '11')?.problems.join('; ')).toContain('more than 100 cross-references');
    expect(lines.find(line => line.row === '11')?.run_id).toBeNull();
    expect(argv(1)).toContain('number=102');
    expect(() => argv(2)).toThrow();
  });

  it('accepts complete empty merged-base references in a shallow source checkout', () => {
    const { repo, cli } = bench();
    const shallow = track(mkdtempSync(join(tmpdir(), 'intake-bench-shallow-')));
    ok(shallow, 'clone', '-q', '--depth=1', `file://${repo}`, '.');
    expect(ok(shallow, 'rev-parse', '--is-shallow-repository')).toBe('true');
    const reader = join(import.meta.dir, '../../workflows/sdlc/intake/scripts/bench/runner.ts');
    const result = spawnSync(process.execPath, ['--preload', join(cli, 'preload.ts'), '--eval',
      `import { readMergedOnBase } from ${JSON.stringify(reader)}; console.log(JSON.stringify(readMergedOnBase(${JSON.stringify(REPO)}, 11, process.cwd(), 'HEAD')));`,
    ], { cwd: shallow, encoding: 'utf8' });
    expect([result.status, result.stderr]).toEqual([0, '']);
    expect(JSON.parse(result.stdout)).toEqual([]);
  });

  for (const fetchMergeObject of [false, true]) {
    it(`refuses shallow merged-base evidence with the merge object ${fetchMergeObject ? 'present' : 'absent'}`, () => {
      const { repo, cli, packSha } = bench();
      ok(repo, 'commit', '-q', '--allow-empty', '-m', 'after the merge');
      const shallow = track(mkdtempSync(join(tmpdir(), 'intake-bench-shallow-')));
      ok(shallow, 'clone', '-q', '--depth=1', `file://${repo}`, '.');
      // Fetching the object alone still leaves the base's ancestry truncated.
      if (fetchMergeObject) ok(shallow, 'fetch', '-q', '--depth=1', repo, packSha);
      const config = JSON.parse(readFileSync(join(cli, 'config.json'), 'utf8')) as FakeConfig;
      config.issues[0] = { ...config.issues[0], refs: [{ url: 'https://github.com/o/r/pull/30', merged: true, oid: packSha }] };
      writeFileSync(join(cli, 'config.json'), JSON.stringify(config));
      expect(spawnSync('git', ['cat-file', '-e', packSha], { cwd: shallow }).status).toBe(fetchMergeObject ? 0 : 1);
      if (fetchMergeObject) expect(spawnSync('git', ['merge-base', '--is-ancestor', packSha, 'HEAD'], { cwd: shallow }).status).toBe(1);
      const reader = join(import.meta.dir, '../../workflows/sdlc/intake/scripts/bench/runner.ts');
      const result = spawnSync(process.execPath, ['--preload', join(cli, 'preload.ts'), '--eval',
        `import { readMergedOnBase } from ${JSON.stringify(reader)}; readMergedOnBase(${JSON.stringify(REPO)}, 11, process.cwd(), 'HEAD');`,
      ], { cwd: shallow, encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('shallow');
      expect(result.stderr).toContain('unshallow');
    });
  }

  it('does not pass a trust: auto row on which intake took a path without triage', () => {
    const { lines } = benchLive({ autoPath: 'quiet' });
    expect(lines.find(line => line.row === '11')).toMatchObject({
      passed: false,
      path: 'quiet',
      verdict: null,
      problems: ['intake took the quiet path, so triage judged nothing'],
    });
  });

  it('refuses a scratch repository that is the set repository, shared, or not at the base', () => {
    const dir = track(mkdtempSync(join(tmpdir(), 'intake-bench-live-')));
    const set: BenchSet = { bench: 'intake', repo: REPO, selected_at: '', rows: [] };
    const live = (value: unknown) => {
      writeFileSync(join(dir, 'live.yaml'), JSON.stringify(value));
      return () => loadLive(join(dir, 'live.yaml'), set);
    };
    expect(live({ a: { repo: REPO, checkout: dir } })).toThrow("a's scratch repository is the set's own repository");
    const shared = { repo: { host: 'github.com', path: 'me/s' }, checkout: dir };
    expect(live({ a: shared, b: shared })).toThrow('b and a share me/s');
    ok(dir, 'init', '-q');
    ok(dir, 'remote', 'add', 'origin', 'https://github.com/me/s.git');
    ok(dir, 'commit', '-q', '--allow-empty', '-m', 'one');
    expect(() => checkScratch('a', shared, '0'.repeat(40))).toThrow('is at');
  });

  it('refuses a concurrency of zero before any run', () => {
    const { runWith } = bench();
    const { status, stderr, lines } = runWith(['--concurrency', '0'], 'base');
    expect([status, stderr.trim(), lines]).toEqual([1, '--concurrency must be at least 1', []]);
  });

  it('pins a dispositioned issue that a typed search also finds, and nothing from a group counted zero', () => {
    const { repo, out, cli } = bench();
    const bare = track(mkdtempSync(join(tmpdir(), 'intake-bench-remote-')));
    ok(bare, 'clone', '-q', '--bare', repo, '.');
    ok(repo, 'config', `url.${bare}.insteadOf`, 'https://github.com/o/r.git');
    const config = JSON.parse(readFileSync(join(cli, 'config.json'), 'utf8')) as FakeConfig;
    writeFileSync(
      join(cli, 'config.json'),
      JSON.stringify({
        ...config,
        issues: [
          { number: 20, labels: ['bug'], comments: 0, state: 'open' },
          { number: 21, labels: ['enhancement'], comments: 0, state: 'open' },
          { number: 30, labels: [], comments: 0 },
        ],
        searches: { 'is:open': [20, 21], 'not planned': [30] },
      })
    );
    writeFileSync(join(out, 'dispositions.json'), JSON.stringify([{ number: 20, contract: 'BLOCKED' }]));
    const counts = ['--duplicates', '0', '--fixed', '0', '--not-planned', '0', '--typed', '1', '--outside', '0'];
    const result = spawnSync(
      process.execPath,
      ['--preload', join(cli, 'preload.ts'), SCRIPT, 'select', '--repo', 'github.com/o/r', '--set', join(out, 'pinned.json'), '--dispositions', join(out, 'dispositions.json'), ...counts],
      { cwd: repo, encoding: 'utf8', env: GH_FORGE }
    );
    expect(result.stderr).toBe('');
    const pinned = JSON.parse(readFileSync(join(out, 'pinned.json'), 'utf8')) as BenchSet;
    expect(pinned.rows.map(entry => [entry.id, entry.group])).toEqual([
      ['21', 'typed'],
      ['20', 'dispositioned'],
    ]);
  });

  it('pins nothing when a group finds fewer issues than the set asks for', () => {
    const { repo, out, cli } = bench();
    const bare = track(mkdtempSync(join(tmpdir(), 'intake-bench-remote-')));
    ok(bare, 'clone', '-q', '--bare', repo, '.');
    ok(repo, 'config', `url.${bare}.insteadOf`, 'https://github.com/o/r.git');
    const config = JSON.parse(readFileSync(join(cli, 'config.json'), 'utf8')) as FakeConfig;
    writeFileSync(join(cli, 'config.json'), JSON.stringify({ ...config, issues: [{ number: 30, labels: [], comments: 0 }], searches: { 'not planned': [30] } }));
    const counts = ['--duplicates', '0', '--fixed', '0', '--not-planned', '2', '--typed', '0', '--outside', '0'];
    const result = spawnSync(
      process.execPath,
      ['--preload', join(cli, 'preload.ts'), SCRIPT, 'select', '--repo', 'github.com/o/r', '--set', join(out, 'pinned.json'), ...counts],
      { cwd: repo, encoding: 'utf8' }
    );
    expect([result.status, result.stderr.trim()]).toEqual([1, 'only 1 not_planned issues were found; the set asks for 2']);
    expect(existsSync(join(out, 'pinned.json'))).toBe(false);
  });

  it('does not pass a run whose judging node recorded no model binding', () => {
    const { run } = bench({ unboundTriage: true });
    const { lines } = run('base');
    expect(lines.find(line => line.row === '11')).toMatchObject({
      passed: false,
      problems: ['triage recorded no model binding, so its version is unproven'],
    });
  });

  it('does not pass a run whose judging node ran on another model than its version pins', () => {
    const { run } = bench({ triageRanAs: { provider: 'codex', model: 'other' } });
    const { lines } = run('base');
    expect(lines.find(line => line.row === '11')).toMatchObject({
      passed: false,
      problems: ['triage ran codex/other, not codex/gpt-x'],
    });
  });

  it('fails the batch with a checks record when the after-read fails', () => {
    const { run } = bench({ issueReadsFailAfterRun: true });
    const { status, checks } = run('base');
    expect(status).toBe(1);
    expect(checks).toHaveLength(1);
    expect(checks[0].passed).toBe(false);
    for (const check of [checks[0].checks.writes, checks[0].checks.posted_text]) {
      expect(check.problems).toEqual([expect.stringContaining('the after-read failed, so the batch is unproven')]);
    }
  });

  it('records a failed transcript read as the row problem, not a lost line', () => {
    const { run } = bench({ unreadableTranscript: true });
    const { lines } = run('base');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.passed).toBe(false);
      expect(line.problems).toEqual([expect.stringContaining('EISDIR')]);
    }
  });

  it('does not pass a verdict whose transcript is missing, since its leak check never ran', () => {
    const { lines } = bench({ noTranscript: true }).run('base');
    expect(lines.map(line => [line.row, line.passed, line.problems])).toEqual([
      ['11', false, ['the transcript is unavailable, so the leak check was not performed']],
      ['12-outside', true, []],
    ]);
  });

  it('fails the batch when an eval run writes to an issue', () => {
    const { run } = bench({ writeLabel: 'archon-ready' });
    const { status, stderr, checks } = run('base');
    expect(status).toBe(1);
    expect(checks[0].passed).toBe(false);
    expect(checks[0].checks.writes.problems).toEqual(expect.arrayContaining([expect.stringContaining('github.com/o/r#12: labels changed')]));
    expect(stderr).toContain('FAILED its hard checks');
  });

  it('fails the batch when an eval run comments on an issue and revises a state document', () => {
    const { run } = bench({ commentAndRecord: true });
    const { status, checks } = run('base');
    expect(status).toBe(1);
    expect(checks[0].checks.writes.problems).toEqual(expect.arrayContaining([expect.stringMatching(/^state o\/r\/work\/12: revision \d+ became \d+$/)]));
    expect(checks[0].checks.posted_text.problems).toEqual(expect.arrayContaining([expect.stringContaining('github.com/o/r#12: 1 comment(s) posted or edited outside declared closure')]));
  });

  it('fails the batch when a trust: outside row runs an agent node', () => {
    const { run } = bench({ outsideAgentRuns: true });
    const { status, checks } = run('base');
    expect(status).toBe(1);
    expect(checks[0].checks.outside_agent.problems).toEqual(['base 12-outside: triage__triage ran']);
  });
});

describe('hard checks', () => {
  const facts = { labels: ['bug'], state: 'open', title: 't', body_digest: 'd', comments: [] };
  const before: Snapshot = { issues: { 'github.com/o/r#1': facts }, state: { 'o/r': { 'work/1': 2 } } };

  it('name a new or revised state document and a posted comment', () => {
    const after: Snapshot = { issues: { 'github.com/o/r#1': { ...facts, comments: [{ id: '1', body: 'unexpected' }] } }, state: { 'o/r': { 'work/1': 3, 'work/2': 1 } } };
    expect(snapshotChanges(before, after)).toEqual([
      'github.com/o/r#1: comments changed',
      'state o/r/work/1: revision 2 became 3',
      'state o/r/work/2: revision none became 1',
    ]);
    expect(postedComments(before, after)).toEqual(['github.com/o/r#1: 1 comment(s) posted or edited outside declared closure']);
    expect([snapshotChanges(before, before), postedComments(before, before)]).toEqual([[], []]);
  });

  it('detects added or removed issues and comments on newly created issues', () => {
    const empty: Snapshot = { issues: {}, state: {} };
    const created: Snapshot = { issues: { 'github.com/o/r#2': { ...facts, comments: [{ id: 'new', body: 'New issue comment' }] } }, state: {} };
    expect(snapshotChanges(empty, created)).toEqual(['github.com/o/r#2: issue added']);
    expect(snapshotChanges(created, empty)).toEqual(['github.com/o/r#2: issue removed']);
    expect(postedComments(empty, created)).toEqual(['github.com/o/r#2: 1 comment(s) posted or edited outside declared closure']);
  });

  it('rejects edits, marker-only imitations, and repeated copies of an allowed comment', () => {
    const body = '<!-- archon-close -->\nClosing as already delivered by https://github.com/o/r/pull/3.';
    const key = 'github.com/o/r#1';
    const was: Snapshot = { issues: { [key]: { ...facts, comments: [{ id: 'old', body: 'Old' }] } }, state: {} };
    for (const comments of [
      [{ id: 'old', body: 'Edited' }],
      [{ id: 'new', body: '<!-- archon-close -->\nOther text' }],
      [{ id: 'new', body }, { id: 'extra', body }],
    ]) {
      const now: Snapshot = { issues: { [key]: { ...facts, comments } }, state: {} };
      expect(postedComments(was, now, new Map([[key, [body]]]))).toHaveLength(1);
    }
  });

  it('fail the batch on a posted comment', () => {
    const context = { set: { bench: 'intake', repo: REPO, selected_at: '', rows: [] }, batch: 1, batchRun: '1-x', base: 'c', outDir: '' } as const;
    const checks = batchChecks(context, 'eval', ['a'], [], [], ['github.com/o/r#1: 1 comment(s) posted or edited outside declared closure']);
    expect([checks.passed, checks.checks.posted_text]).toEqual([false, { ok: false, problems: ['github.com/o/r#1: 1 comment(s) posted or edited outside declared closure'] }]);
  });
});

describe('run cost', () => {
  const provider = (value: number) => ({ costUsd: { source: 'provider' as const, value } });

  it('sums every attempt of each agent node that ran', () => {
    const nodes = [
      { nodeId: 'triage', state: 'completed', kind: 'agent', attempts: [provider(0.25), provider(0.5)] },
      { nodeId: 'judge', state: 'skipped', kind: 'agent', attempts: [] },
      { nodeId: 'read', state: 'completed', kind: 'bash', attempts: [{}] },
    ];
    expect(runCost(nodes)).toBe(0.75);
    expect(runCost([{ ...nodes[0], attempts: [provider(0.25), {}] }])).toBeNull();
  });
});

describe('returned value', () => {
  const detail = (returns: RunDetail['returns']): RunDetail => ({
    id: 'r1',
    status: 'completed',
    output_root: '/tmp',
    started_at: '',
    completed_at: null,
    base_branch: 'dev',
    aliases: {},
    transcript_path: null,
    returns,
    nodes: [],
  });

  it('reads a spilled value back from its file', () => {
    const spill = join(track(mkdtempSync(join(tmpdir(), 'intake-bench-spill-'))), 'returns.json');
    writeFileSync(spill, JSON.stringify({ verdict: 'big' }));
    expect(returnedValue(detail({ availability: 'truncated', spill_path: spill }))).toEqual({ verdict: 'big' });
  });

  it('throws with the reason when there is no value', () => {
    expect(() => returnedValue(detail({ availability: 'unavailable', reason: 'node_failed' }))).toThrow('run r1 returned no value: {"availability":"unavailable","reason":"node_failed"}');
    expect(() => returnedValue(detail(null))).toThrow('the field `terminal_record.returns` is missing');
  });
});

describe('engine names the bench copies', () => {
  it('the judge node id is the agent node of archon-triage, alone and as intake includes it', () => {
    registerBuiltinProviders();
    const pack = join(import.meta.dir, '../../workflows/sdlc');
    const definitions = new Map<string, WorkflowDefinition>();
    for (const file of ['intake/archon-intake.yaml', 'triage/archon-triage.yaml']) {
      const parsed = parseWorkflow(readFileSync(join(pack, file), 'utf8'), file, providerRegistry);
      if (parsed.workflow === null) throw new Error(parsed.error.error);
      definitions.set(parsed.workflow.name, parsed.workflow);
    }
    const { workflows, errors } = expandWorkflowIncludes(definitions, new Map([['triage', 'Triage.']]));
    expect(errors).toEqual([]);
    const agentIds = (name: string) => (workflows.get(name)?.nodes ?? []).filter(node => node.kind === 'agent').map(node => node.id);
    expect(agentIds('archon-triage')).toEqual([triageNodeId('triage')]);
    expect(agentIds('archon-intake')).toEqual([triageNodeId('intake')]);
    expect(TRIAGE_VERDICT_NODE).toBe(`triage__${String(definitions.get('archon-triage')?.returns)}`);
  });
});

describe('dry-run stand-ins', () => {
  it('satisfy archon-triage as the pack declares it at this commit', () => {
    registerBuiltinProviders();
    const root = join(import.meta.dir, '../../..');
    const workflowPath = '.archon/workflows/sdlc/triage/archon-triage.yaml';
    const parsed = parseWorkflow(readFileSync(join(root, workflowPath), 'utf8'), workflowPath, providerRegistry);
    if (parsed.workflow === null) throw new Error(parsed.error.error);
    const stubs = bindingStubs(root, workflowPath);
    for (const [id, stub] of Object.entries(stubs)) {
      const node = parsed.workflow.nodes.find(entry => entry.id === id);
      if (node === undefined || !('output_format' in node) || node.output_format === undefined) throw new Error(`${id} declares no output_format`);
      expect(validateStructuredOutput(stub, node.output_format)).toEqual({ valid: true });
    }
    // The policy and verdict scripts run for real.
    expect(Object.keys(stubs)).toEqual(['triage']);
  });
});

describe('leaks', () => {
  it('flag a lookup that names the judged issue, whatever records it, and nothing else', () => {
    const event = (body: Record<string, unknown>) => JSON.stringify({ type: 'provider_event', step: 'triage', event: body });
    const call = (id: string, name: string, rawInput: unknown) => event({ type: 'tool_call', toolCallId: id, name, rawInput });
    // Codex runs a shell command through unified exec as a subtask; its start and end both name it.
    const exec = (status: string) =>
      event({ type: 'subtask', taskId: 'command:t:1', taskType: 'command_execution', status, description: "/bin/zsh -lc 'gh issue view 4 --repo o/r'" });
    const transcript = [
      call('a', 'Bash', { command: 'gh issue view 41' }),
      call('b', 'Bash', { command: 'gh issue view 4 --repo o/r' }),
      call('c', 'WebFetch', { url: 'https://github.com/o/r/issues/4#issuecomment-1' }),
      // The issue number may follow the command's flags, and may be quoted.
      call('f', 'Bash', { command: 'gh issue view --repo o/r 4 --comments' }),
      call('g', 'Bash', { command: 'gh issue view -R o/r --comments "#4"' }),
      call('n', 'Bash', { command: "gh issue view --jq '(.body)' 4" }),
      // Another command in the same line naming the number looks nothing up.
      call('h', 'Bash', { command: 'gh issue view 41 --repo o/r && echo 4' }),
      call('i', 'Bash', { command: 'gh issue view 41\nls 4' }),
      // The number may close a command substitution or precede a redirect.
      call('j', 'Bash', { command: 'BODY=$(gh issue view 4)' }),
      call('k', 'Bash', { command: 'BODY=`gh issue view 4`' }),
      call('l', 'Bash', { command: 'gh issue view 4>/tmp/i' }),
      call('m', 'Bash', { command: 'BODY=$(gh issue view 41)' }),
      exec('started'),
      exec('completed'),
      // Writing the report that cites the issue is no lookup.
      call('d', 'file_change', { changes: [{ path: 'triage.md', diff: '+ https://github.com/o/r/issues/4' }] }),
      call('e', 'Write', { file_path: 'triage.md', content: 'See https://github.com/o/r/issues/4' }),
      event({ type: 'text', text: 'issues/4' }),
    ].join('\n');
    expect(findLeaks(transcript, issueTokens(REPO, 4))).toEqual([
      'triage: gh issue view 4 --repo o/r',
      'triage: https://github.com/o/r/issues/4#issuecomment-1',
      'triage: gh issue view --repo o/r 4 --comments',
      'triage: gh issue view -R o/r --comments "#4"',
      "triage: gh issue view --jq '(.body)' 4",
      'triage: BODY=$(gh issue view 4)',
      'triage: BODY=`gh issue view 4`',
      'triage: gh issue view 4>/tmp/i',
      "triage: /bin/zsh -lc 'gh issue view 4 --repo o/r'",
    ]);
  });
});

describe('score', () => {
  const version = (label: string): Version => ({
    label,
    pack_sha: 'a'.repeat(40),
    prompt_sha: { triage: 'b'.repeat(40) },
    provider: 'claude',
    model: label,
    tier: 'medium',
  });
  const field = (value: string) => ({ value, reason: 'r' });

  function line(label: string, row: Row, batchRun: string, overrides: Partial<Line> = {}): Line {
    return {
      at: '2026-10-15T00:00:00Z',
      batch: Number(batchRun.split('-')[0]),
      batch_run: batchRun,
      mode: 'eval',
      base: 'c'.repeat(40),
      row: row.id,
      number: row.number,
      group: row.group,
      workflow: row.workflow,
      trust: row.trust,
      version: version(label),
      run_id: `${label}-${row.id}-${batchRun}`,
      status: 'completed',
      passed: true,
      problems: [],
      path: null,
      agent_nodes: ['triage'],
      binding: null,
      verdict: {
        contract: 'NO_ACTION',
        route: null,
        pull_request: null,
        type: field('feature'),
        size: field('s'),
        complexity: field('low'),
        importance: field('low'),
        urgency: field('none'),
        blocked_by: [],
      },
      cost_usd: 1,
      duration_ms: 60_000,
      leak: [],
      report: null,
      ...overrides,
    };
  }

  const checks = (batchRun: string, passed: boolean): BatchChecks => {
    const ok = { ok: true, problems: [] };
    return {
      at: '2026-10-15T00:00:00Z',
      batch: Number(batchRun.split('-')[0]),
      batch_run: batchRun,
      mode: 'eval',
      labels: ['a', 'b'],
      checks: { writes: passed ? ok : { ok: false, problems: ['wrote'] }, outside_agent: ok, posted_text: ok, finished: ok },
      passed,
    };
  };

  const dup = row(1, { group: 'duplicate', known: { canonical: 'https://github.com/o/r/issues/9', type: 'feature' } });
  const typed = row(2, { group: 'typed', known: { type: 'bug' } });
  const fixed = row(6, { group: 'fixed', known: { fixed_by: 'https://github.com/o/r/pull/3' } });
  const leaked = row(7, { group: 'fixed' });
  const set: BenchSet = { bench: 'intake', repo: REPO, selected_at: '2026-10-15T00:00:00Z', rows: [dup, typed, row(3), row(4), row(5), fixed, leaked] };

  function benchOut(): string {
    const out = track(mkdtempSync(join(tmpdir(), 'intake-bench-score-')));
    const samples = join(out, SAMPLES_FILE);
    // An older line for row 2 that the rerun replaces.
    appendLine(samples, line('a', typed, '1-old', { verdict: null }));
    appendLine(samples, line('a', dup, '1-x'));
    appendLine(samples, line('a', typed, '1-x', { verdict: { ...line('a', typed, '1-x').verdict!, contract: 'READY', route: 'plan', type: field('bug') } }));
    appendLine(samples, line('b', dup, '1-x', { verdict: { ...line('b', dup, '1-x').verdict!, contract: 'BLOCKED', blocked_by: ['https://github.com/o/r/issues/9'], type: field('bug') } }));
    appendLine(samples, line('b', typed, '1-x'));
    appendLine(samples, line('a', fixed, '2-y'));
    appendLine(samples, line('b', fixed, '2-y'));
    appendLine(samples, line('a', leaked, '2-y', { leak: ['triage: gh issue view 7'] }));
    appendLine(samples, line('b', leaked, '3-z'));
    for (const record of [checks('1-old', true), checks('1-x', true), checks('2-y', true), checks('3-z', false)]) appendLine(join(out, CHECKS_FILE), record);
    return out;
  }

  it('reads the latest line per row, the human type with enhancement as feature, and excludes leaks and failed batches', () => {
    const out = benchOut();
    const [a, b] = score(set, out).versions;
    expect(a.type).toEqual({ rows: 2, agree: 2, matrix: { feature: { feature: 1 }, bug: { bug: 1 } } });
    expect(b.type).toEqual({ rows: 2, agree: 0, matrix: { feature: { bug: 1 }, bug: { feature: 1 } } });
    // b closed the open typed row without a person.
    expect([a.false_closes, b.false_closes]).toEqual([[], ['2']]);
    expect(a.leaks).toEqual(['7']);
    expect(b.failed_batches).toEqual(['3-z']);
    expect(b.hard.writes).toBe(1);
    expect(b.bars.duplicate.cites_canonical).toBe(1);
    expect(b.bars.fixed.rows).toBe(1);
  });

  it('tallies marks across batches and leaves a bar pending until every row is marked', () => {
    const out = benchOut();
    appendLine(join(out, MARKS_FILE), { run_id: 'a-1-1-x', batch: 1, row: '1', label: 'a', mark: 'wrong', note: '' });
    appendLine(join(out, MARKS_FILE), { run_id: 'a-1-1-x', batch: 1, row: '1', label: 'a', mark: 'right', note: 'second look' });
    appendLine(join(out, MARKS_FILE), { run_id: 'a-6-2-y', batch: 2, row: '6', label: 'a', mark: 'partly', note: '' });
    appendLine(join(out, MARKS_FILE), { run_id: 'b-1-1-x', batch: 1, row: '1', label: 'b', mark: 'right', note: '' });
    const result = score(set, out);
    const [a, b] = result.versions;
    expect(a.marks).toEqual({ right: 1, wrong: 0, partly: 1, unmarked: 1 });
    expect(a.bars.duplicate.status).toBe('pass');
    expect(a.bars.fixed).toMatchObject({ rows: 1, right: 0, partly: 1, status: 'fail' });
    expect(b.bars.fixed.status).toBe('pending');
    expect(result.disagreements.map(entry => [entry.row, entry.right, entry.type_right])).toEqual([
      ['1', ['a', 'b'], ['a']],
      ['2', [], ['a']],
      ['6', [], []],
    ]);
    expect(renderScore(result)).toContain('| duplicates found with the right canonical link (at least 70%, by marks) | 1/1 (100%) right');
    expect(renderScore(result)).toContain('| text posted in eval or outside a declared live closure |');
  });

  it('counts a run that did not pass against its bars as not right', () => {
    const out = benchOut();
    const failed = { status: 'failed' as const, passed: false, verdict: null };
    appendLine(join(out, SAMPLES_FILE), line('a', dup, '1-x', failed));
    appendLine(join(out, SAMPLES_FILE), line('a', typed, '1-x', failed));
    appendLine(join(out, MARKS_FILE), { run_id: 'a-6-2-y', batch: 2, row: '6', label: 'a', mark: 'right', note: '' });
    const crashed = row(9, { group: 'fixed' });
    appendLine(join(out, SAMPLES_FILE), line('a', crashed, '2-y', failed));
    appendLine(join(out, SAMPLES_FILE), line('a', leaked, '2-y', { ...failed, leak: ['triage: gh issue view 7'] }));
    // No human type, so only the dispositions count it.
    const dispositioned = row(10, { group: 'dispositioned', known: { disposition: { contract: 'BLOCKED' } } });
    appendLine(join(out, SAMPLES_FILE), line('a', dispositioned, '2-y', failed));
    const [a] = score({ ...set, rows: [...set.rows, crashed, dispositioned] }, out).versions;
    expect(a.bars.duplicate).toMatchObject({ rows: 1, right: 0, failed: 1, unmarked: 0, status: 'fail' });
    expect(a.bars.fixed).toMatchObject({ rows: 2, right: 1, failed: 1, status: 'fail' });
    expect(a.type).toEqual({ rows: 2, agree: 0, matrix: { feature: { failed: 1 }, bug: { failed: 1 } } });
    expect(a.dispositions).toEqual({ rows: 1, agree: 0 });
    expect(a.leaks).toEqual(['7']);
    expect(a.unscored).toEqual(['2', '1', '9', '10']);
  });

  it('counts a close proposal only on a row that was open, unless its disposition closes it', () => {
    const out = benchOut();
    const proposeClose = { verdict: line('a', dup, '1-x').verdict };
    const notPlanned = row(20, { group: 'not_planned' });
    const closeDisposed = row(21, { group: 'dispositioned', known: { disposition: { contract: 'NO_ACTION' } } });
    const blockDisposed = row(22, { group: 'dispositioned', known: { disposition: { contract: 'BLOCKED' } } });
    for (const entry of [notPlanned, closeDisposed, blockDisposed]) appendLine(join(out, SAMPLES_FILE), line('a', entry, '2-y', proposeClose));
    const [a, b] = score({ ...set, rows: [...set.rows, notPlanned, closeDisposed, blockDisposed] }, out).versions;
    // a proposes a close on the closed duplicate, fixed and not-planned rows too.
    expect([a.false_closes, b.false_closes]).toEqual([['22'], ['2']]);
  });

  function liveOut(): string {
    const out = benchOut();
    const samples = readLines(join(out, SAMPLES_FILE));
    writeFileSync(join(out, SAMPLES_FILE), '');
    for (const sample of samples) appendLine(join(out, SAMPLES_FILE), { ...sample, mode: 'live', workflow: 'intake', merged_on_base: [] });
    const records = readLines(join(out, CHECKS_FILE));
    writeFileSync(join(out, CHECKS_FILE), '');
    for (const record of records) appendLine(join(out, CHECKS_FILE), { ...record, mode: 'live' });
    return out;
  }

  it('keeps historical live closes without collected evidence unresolved', () => {
    const out = liveOut();
    appendLine(join(out, SAMPLES_FILE), line('b', typed, '1-x', { mode: 'live', workflow: 'intake' }));
    const result = score(set, out).versions[1];
    expect([result.false_closes, result.pending_closes]).toEqual([[], ['2']]);
    expect(renderPage(set, out, 1)).toContain('Merged-base evidence was not collected');
    expect(renderPage(set, out, 1)).toContain('Rerun this live row');
    expect(renderScore(score(set, out))).toContain('0, 1 awaiting operator judgment (2): pending');
    appendLine(join(out, MARKS_FILE), { run_id: 'b-2-1-x', batch: 1, row: '2', label: 'b', mark: 'partly', note: '' });
    expect(score(set, out).versions[1].pending_closes).toEqual(['2']);
    appendLine(join(out, MARKS_FILE), { run_id: 'b-2-1-x', batch: 1, row: '2', label: 'b', mark: 'wrong', note: '' });
    expect(score(set, out).versions[1].false_closes).toEqual(['2']);
    appendLine(join(out, MARKS_FILE), { run_id: 'b-2-1-x', batch: 1, row: '2', label: 'b', mark: 'right', note: '' });
    expect(score(set, out).versions[1].pending_closes).toEqual([]);
  });

  it('keeps reference-only closes pending until the operator judges the fix', () => {
    const out = liveOut();
    const fixedOnBase = { merged_on_base: ['https://github.com/o/r/pull/40'] };
    appendLine(join(out, SAMPLES_FILE), line('b', typed, '1-x', { ...fixedOnBase, mode: 'live', workflow: 'intake' }));
    const pending = score(set, out).versions[1];
    expect([pending.false_closes, pending.pending_closes]).toEqual([[], ['2']]);
    expect(renderScore(score(set, out))).toContain('0, 1 awaiting operator judgment (2): pending');
    expect(renderPage(set, out, 1)).toContain('A merged pull request on the base references this issue: <a href="https://github.com/o/r/pull/40">');
    appendLine(join(out, MARKS_FILE), { run_id: 'b-2-1-x', batch: 1, row: '2', label: 'b', mark: 'partly', note: '' });
    expect(score(set, out).versions[1].pending_closes).toEqual(['2']);
    expect(renderPage(set, out, 1)).toContain('the close bar stays pending');
    appendLine(join(out, MARKS_FILE), { run_id: 'b-2-1-x', batch: 1, row: '2', label: 'b', mark: 'wrong', note: '' });
    expect(score(set, out).versions[1].false_closes).toEqual(['2']);
    expect(renderPage(set, out, 1)).not.toContain('the close bar stays pending');
    appendLine(join(out, MARKS_FILE), { run_id: 'b-2-1-x', batch: 1, row: '2', label: 'b', mark: 'right', note: 'verified fix' });
    expect(renderPage(set, out, 1)).not.toContain('the close bar stays pending');
    expect(renderScore(score(set, out))).toContain('| false closes (none allowed) | 0: pass | 0: pass |');
  });

  it('lets a wrong operator mark overturn an open close disposition, retaining closed rows', () => {
    const disposed = row(21, { group: 'dispositioned', known: { disposition: { contract: 'NO_ACTION' } } });
    const proposed = line('a', disposed, '2-y', { mode: 'live', workflow: 'intake' });
    expect(([undefined, 'right', 'wrong', 'partly'] as const).map(mark => closeCheck(disposed, proposed, mark))).toEqual([null, null, 'false', null]);
    expect(closeCheck(fixed, line('a', fixed, '2-y', { mode: 'live', workflow: 'intake' }), 'wrong')).toBeNull();
    const out = liveOut();
    appendLine(join(out, SAMPLES_FILE), proposed);
    appendLine(join(out, MARKS_FILE), { run_id: proposed.run_id, batch: 2, row: disposed.id, label: 'a', mark: 'wrong', note: '' });
    expect(score({ ...set, rows: [...set.rows, disposed] }, out).versions[0].false_closes).toEqual(['21']);
  });

  it('lets a mark override the expected answer for closes and dispositions, but not for type', () => {
    const out = liveOut();
    expect(renderPage(set, out, 1)).toContain('Counts as a false close unless you mark it right.');
    appendLine(join(out, MARKS_FILE), { run_id: 'b-2-1-x', batch: 1, row: '2', label: 'b', mark: 'right', note: '' });
    expect(renderPage(set, out, 1)).not.toContain('Counts as a false close unless you mark it right.');
    const blocked = row(10, { group: 'dispositioned', known: { disposition: { contract: 'BLOCKED' } } });
    const ready = { verdict: { ...line('a', blocked, '2-y').verdict!, contract: 'READY' as const, route: 'plan' as const } };
    appendLine(join(out, SAMPLES_FILE), line('a', blocked, '2-y', { ...ready, mode: 'live', workflow: 'intake' }));
    appendLine(join(out, SAMPLES_FILE), line('b', blocked, '2-y', { mode: 'live', workflow: 'intake', verdict: { ...ready.verdict, contract: 'BLOCKED', route: null } }));
    const withBlocked: BenchSet = { ...set, rows: [...set.rows, blocked] };
    const before = score(withBlocked, out).versions;
    expect([before[0].dispositions.agree, before[1].dispositions.agree]).toEqual([0, 1]);
    appendLine(join(out, MARKS_FILE), { run_id: 'a-10-2-y', batch: 2, row: '10', label: 'a', mark: 'right', note: '' });
    appendLine(join(out, MARKS_FILE), { run_id: 'b-10-2-y', batch: 2, row: '10', label: 'b', mark: 'wrong', note: '' });
    const [a, b] = score(withBlocked, out).versions;
    expect([a.dispositions.agree, b.dispositions.agree]).toEqual([1, 0]);
    expect(b.false_closes).toEqual([]);
    // b's type on row 2 still disagrees with the human label, whatever the mark.
    expect(b.type.agree).toBe(0);
  });

  it('reads a bar with no applicable rows as not applicable', () => {
    const out = liveOut();
    const result = score(set, out);
    expect(renderScore(result)).toContain('| every `trust: outside` row ran no agent node | 0 of 0 ran one: not applicable |');
    expect(result.versions[0].bars.not_planned.status).toBe('not applicable');
    const empty = track(mkdtempSync(join(tmpdir(), 'intake-bench-score-')));
    appendLine(join(empty, SAMPLES_FILE), line('a', fixed, '2-y', { mode: 'live', workflow: 'intake' }));
    appendLine(join(empty, CHECKS_FILE), { ...checks('2-y', true), mode: 'live' });
    const closedOnly = renderScore(score(set, empty));
    expect(closedOnly).toContain('| false closes (none allowed) | 0: not applicable |');
    expect(closedOnly).toContain('| `type` agreement (at least 80%) | -: not applicable |');
  });

  it('counts a close proposal that links the canonical issue, and shows its link', () => {
    const out = benchOut();
    const closure = { kind: 'duplicate' as const, url: 'https://github.com/o/r/issues/9', original: { repo: REPO, number: 9 } };
    appendLine(join(out, SAMPLES_FILE), line('a', dup, '1-x', { verdict: { ...line('a', dup, '1-x').verdict!, closure } }));
    expect(score(set, out).versions[0].bars.duplicate.cites_canonical).toBe(1);
    expect(renderPage(set, out, 1)).toContain('<b>Proposes close</b> without a person: duplicate of <a href="https://github.com/o/r/issues/9">');
    const triaged = { contract: 'NO_ACTION', route: 'no_action', type: field('bug'), size: field('s'), complexity: field('low'), importance: field('low'), urgency: field('none'), closure };
    expect(toVerdict(triaged).closure).toEqual(closure);
  });

  it('leaves runs in which no agent ran out of the cost, and shows a cost no provider reported as unreported', () => {
    const out = track(mkdtempSync(join(tmpdir(), 'intake-bench-score-')));
    const outside = row(1, { id: '1-outside', workflow: 'intake', trust: 'outside' });
    appendLine(join(out, SAMPLES_FILE), line('a', dup, '1-x', { cost_usd: null }));
    appendLine(join(out, SAMPLES_FILE), line('a', outside, '1-x', { workflow: 'intake', agent_nodes: [], verdict: null, cost_usd: 0 }));
    appendLine(join(out, CHECKS_FILE), checks('1-x', true));
    const result = score({ ...set, rows: [...set.rows, outside] }, out);
    expect(result.versions[0].cost).toEqual({ runs: 1, unreported: 1, total: 0, mean: null });
    expect(renderScore(result)).toContain('| cost per item, mean (no bar) | unreported |');
    expect(renderScore(result)).toContain('| cost total | unreported |');
  });

  it('labels which workflow judged each row', () => {
    const out = benchOut();
    appendLine(join(out, SAMPLES_FILE), line('b', typed, '1-x', { workflow: 'intake', verdict: { ...line('b', typed, '1-x').verdict!, type: field('bug') } }));
    const result = score(set, out);
    expect(result.versions.map(version => version.workflows)).toEqual([{ 'archon-triage': 3 }, { 'archon-triage': 2, 'intake eval': 1 }]);
    expect(result.disagreements.find(entry => entry.row === '2')?.workflows).toEqual({ a: 'archon-triage', b: 'intake eval' });
    expect(renderScore(result)).toContain('| 2 (typed) | READY/plan bug (archon-triage) | NO_ACTION bug (intake eval) |');
  });

  it('fails the outside bar when a trust: outside row ran an agent, and keeps the row out of accuracy', () => {
    const out = benchOut();
    const outside = row(2, { id: '2-outside', group: 'typed', workflow: 'intake', trust: 'outside', known: { type: 'bug' } });
    const withOutside: BenchSet = { ...set, rows: [...set.rows, outside] };
    const before = score(withOutside, out).versions[0];
    appendLine(join(out, SAMPLES_FILE), line('a', outside, '1-x', { workflow: 'intake', agent_nodes: ['triage__triage'] }));
    const after = score(withOutside, out);
    expect(after.versions[0].outside).toEqual({ rows: 1, ran_agent: 1 });
    expect(after.versions[0].type).toEqual(before.type);
    expect(renderScore(after)).toContain('| every `trust: outside` row ran no agent node | 1 of 1 ran one: fail |');
  });

  it('scores a live line in its own column, without canonical links, leaving the eval column as it was', () => {
    const out = benchOut();
    const before = score(set, out).versions[0];
    appendLine(join(out, SAMPLES_FILE), line('a', dup, '4-live', { mode: 'live', workflow: 'intake', verdict: { ...line('a', dup, '4-live').verdict!, blocked_by: undefined } }));
    appendLine(join(out, CHECKS_FILE), { ...checks('4-live', true), mode: 'live' });
    const result = score(set, out);
    expect(result.versions.map(version => version.label)).toEqual(['a', 'b', 'a (live)']);
    expect(result.versions[0]).toEqual(before);
    expect(result.versions[2]).toMatchObject({ workflows: { 'intake live': 1 }, bars: { duplicate: { rows: 1, cites_canonical: null } } });
    expect(renderScore(result)).toContain('links not recorded live');
  });

  it('serves no mark for a run of a batch that failed its hard checks', () => {
    const out = benchOut();
    const batchSet: BenchSet = { ...set, rows: [leaked, ...set.rows.filter(entry => entry !== leaked)] };
    expect(() => postMark(batchSet, out, 1, { run_id: 'b-7-3-z', mark: 'right', note: '' })).toThrow('is not a markable run of batch 1');
    postMark(batchSet, out, 1, { run_id: 'a-1-1-x', mark: 'partly', note: '<b>' });
    expect(readLines(join(out, MARKS_FILE))).toMatchObject([{ run_id: 'a-1-1-x', label: 'a', mark: 'partly', note: '<b>' }]);
    const page = renderPage(batchSet, out, 1);
    expect(page).toContain('This batch failed a hard check.');
    expect(page).toContain('&lt;b&gt;');
    expect(page).not.toContain('<textarea name="note" placeholder="note"><b>');
  });
});
