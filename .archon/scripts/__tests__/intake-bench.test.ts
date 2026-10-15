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
  findLookups,
  issueTokens,
  type Line,
  postedComments,
  runCost,
  splitLookups,
  type Snapshot,
  snapshotChanges,
  toVerdict,
  triageNodeId,
  type Version,
} from '../../workflows/sdlc/intake/scripts/bench/runner';
import { answerLookup, atCreation, type CreationView, creationLabels, serveLookups } from '../../workflows/sdlc/intake/scripts/bench/lookups';
import { MARKS_FILE, renderScore, score } from '../../workflows/sdlc/intake/scripts/bench/score';
import {
  type BenchSet,
  humanType,
  orderRows,
  parseDispositions,
  type Row,
  toCandidate,
} from '../../workflows/sdlc/intake/scripts/bench/set';
import type { FakeConfig } from './fake-intake-bench-cli';

const track = trackTempRoots();
const REPO = { host: 'github.com', path: 'o/r' };
const SCRIPT = join(import.meta.dir, '../../workflows/sdlc/intake/scripts/bench/bench.ts');
const FAKE = join(import.meta.dir, 'fake-intake-bench-cli.ts');

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
      rows: [row(11), row(12, { id: '12-outside', group: 'fixed', workflow: 'intake', trust: 'outside', author: 'Maintainer' })],
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
  function benchLive(scenario: Partial<FakeConfig> = {}) {
    const { runWith, argv, repo, out, cli } = bench(scenario);
    const scratch = track(mkdtempSync(join(tmpdir(), 'intake-bench-scratch-')));
    ok(scratch, 'clone', '-q', repo, '.');
    ok(scratch, 'remote', 'set-url', 'origin', 'git@github.com:me/scratch-base.git');
    writeFileSync(join(out, 'live.yaml'), JSON.stringify({ base: { repo: { host: 'github.com', path: 'me/scratch-base' }, checkout: scratch } }));
    mkdirSync(join(out, 'bench', 'live'), { recursive: true });
    writeFileSync(join(out, 'bench', 'live', 'base.json'), JSON.stringify({ repo: { host: 'github.com', path: 'me/scratch-base' }, copies: { '11': 101, '12-outside': 102 } }));
    const config = JSON.parse(readFileSync(join(cli, 'config.json'), 'utf8')) as FakeConfig;
    config.issues.push({ number: 101, labels: [], comments: 0 }, { number: 102, labels: [], comments: 0 });
    writeFileSync(join(cli, 'config.json'), JSON.stringify(config));
    return { ...runWith(['--live', join(out, 'live.yaml')], 'base'), argv, scratch };
  }

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

  it('does not read eval metadata for live scratch runs', () => {
    const refs = Array.from({ length: 101 }, (_, i) => ({ url: `https://github.com/o/r/pull/${String(i)}`, merged: false, oid: null }));
    const { status, lines } = benchLive({ issues: [{ number: 11, labels: [], comments: 0, refs }, { number: 12, labels: [], comments: 0 }] });
    expect(status).toBe(0);
    expect(lines.every(line => line.status === 'completed')).toBe(true);
  });

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
      { cwd: repo, encoding: 'utf8' }
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
    expect(checks[0].checks.posted_text.problems).toEqual(expect.arrayContaining([expect.stringContaining('github.com/o/r#12: 1 comment(s) posted')]));
  });

  it('answers a lookup of the judged issue as it was at creation, and the lookup is not a leak', () => {
    const { run, cli } = bench({
      lookupIssue: 11,
      issues: [
        {
          number: 11,
          labels: ['bug', 'archon-ready'],
          comments: 1,
          createdAt: '2026-10-01T10:00:00Z',
          labelEvents: [
            { createdAt: '2026-10-01T10:00:01Z', actor: 'someone', label: 'bug' },
            { createdAt: '2026-10-01T11:00:00Z', actor: 'Maintainer', label: 'archon-ready' },
          ],
        },
        { number: 12, labels: ['bug'], comments: 2 },
      ],
    });
    const { status, stderr, lines } = run('base');
    expect([status, stderr]).toEqual([0, '']);
    const triaged = lines.find(line => line.row === '11');
    const n = Number(triaged?.run_id?.slice('run-'.length));
    const looked = JSON.parse(readFileSync(join(cli, `lookup-run-${String(n)}.json`), 'utf8'));
    expect(looked.data.repository.issue).toEqual({
      id: 'I_11',
      number: 11,
      title: 'Issue 11 as opened',
      body: 'The body 11 was opened with.',
      state: 'OPEN',
      stateReason: null,
      closedAt: null,
      url: 'https://github.com/o/r/issues/11',
      labels: { nodes: [{ name: 'bug' }], totalCount: 1 },
      comments: { nodes: [], totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null } },
    });
    expect(triaged?.leak).toEqual([]);
    expect(triaged?.answered_at_creation).toEqual(['triage: gh issue view 11 --repo o/r --json title,body,state,labels,comments']);
  });

  it('answers literal GraphQL lookups of the judged issue at creation too', () => {
    const { run, cli } = bench({ lookupIssue: 11, lookupLiteral: true });
    const { lines } = run('base');
    const triaged = lines.find(line => line.row === '11');
    const n = Number(triaged?.run_id?.slice('run-'.length));
    expect(JSON.parse(readFileSync(join(cli, `lookup-literal-run-${String(n)}.json`), 'utf8'))).toEqual({ data: { repository: { issue: { state: 'OPEN' } } } });
    expect(triaged?.answered_at_creation).toEqual(['triage: gh issue view 11 --repo o/r --json title,body,state,labels,comments']);
    expect(triaged?.leak).toEqual([]);
  });

  it('records the merged pull requests on the base that reference the row issue', () => {
    const { runWith, repo, cli } = bench();
    const config = JSON.parse(readFileSync(join(cli, 'config.json'), 'utf8')) as FakeConfig;
    ok(repo, 'commit', '-q', '--allow-empty', '-m', 'after the base');
    const refs = [
      { url: 'https://github.com/o/r/pull/30', merged: true, oid: ok(repo, 'rev-parse', 'HEAD~1') },
      { url: 'https://github.com/o/r/pull/31', merged: true, oid: ok(repo, 'rev-parse', 'HEAD') },
      { url: 'https://github.com/o/r/pull/32', merged: false, oid: null },
      { connected: true, url: 'https://github.com/o/r/pull/33', merged: true, oid: ok(repo, 'rev-parse', 'HEAD~1') },
    ];
    writeFileSync(join(cli, 'config.json'), JSON.stringify({ ...config, issues: config.issues.map(issue => (issue.number === 11 ? { ...issue, refs } : issue)) }));
    const { status, lines, checks } = runWith(['--base', 'HEAD~1'], 'base');
    expect(status).toBe(0);
    expect(lines.find(line => line.row === '11')?.merged_on_base).toEqual(['https://github.com/o/r/pull/30', 'https://github.com/o/r/pull/33']);
    expect(lines.find(line => line.row === '12-outside')?.merged_on_base).toEqual([]);
    const line = lines.find(line => line.row === '11');
    if (line === undefined) throw new Error('missing connected row');
    const set: BenchSet = { bench: 'intake', repo: REPO, selected_at: '', rows: [row(11, { group: 'typed' })] };
    const out = track(mkdtempSync(join(tmpdir(), 'intake-bench-score-')));
    appendLine(join(out, CHECKS_FILE), checks[0]);
    appendLine(join(out, SAMPLES_FILE), { ...line, group: 'typed', verdict: { ...line.verdict, contract: 'NO_ACTION', route: null } });
    expect(renderScore(score(set, out))).toContain('1 excused by a merged base PR');
  });

  it('refuses an incomplete page of label history before launching the row', () => {
    const labelEvents = Array.from({ length: 21 }, (_, i) => ({ createdAt: '2026-01-01T00:00:01Z', actor: 'someone', label: String(i) }));
    const { run } = bench({ issues: [{ number: 11, labels: [], comments: 0, labelEvents }, { number: 12, labels: [], comments: 0 }] });
    const { lines } = run('base');
    expect(lines.find(line => line.row === '11')).toMatchObject({ status: 'not_started', problems: [expect.stringContaining('label events')] });
  });

  it('counts a merged PR whose merge commit this clone lacks, such as another repository\'s, as not on the base', () => {
    const { run, cli } = bench();
    const config = JSON.parse(readFileSync(join(cli, 'config.json'), 'utf8')) as FakeConfig;
    const refs = [{ url: 'https://github.com/fork/r/pull/7', merged: true, oid: 'f'.repeat(40) }];
    writeFileSync(join(cli, 'config.json'), JSON.stringify({ ...config, issues: config.issues.map(issue => (issue.number === 11 ? { ...issue, refs } : issue)) }));
    const { status, stderr, lines } = run('base');
    expect([status, stderr]).toEqual([0, '']);
    const row = lines.find(line => line.row === '11');
    expect([row?.status, row?.merged_on_base]).toEqual(['completed', []]);
  });

  it('does not run a row whose issue the bench cannot read in full, and runs the rest', () => {
    const { run, cli } = bench();
    const config = JSON.parse(readFileSync(join(cli, 'config.json'), 'utf8')) as FakeConfig;
    const refs = Array.from({ length: 101 }, (_, i) => ({ url: `https://github.com/o/r/pull/${String(100 + i)}`, merged: false, oid: null }));
    writeFileSync(join(cli, 'config.json'), JSON.stringify({ ...config, issues: config.issues.map(issue => (issue.number === 11 ? { ...issue, refs } : issue)) }));
    const { status, lines, checks } = run('base');
    expect(status).toBe(1);
    const unread = lines.find(line => line.row === '11');
    expect([unread?.run_id, unread?.status, unread?.passed]).toEqual([null, 'not_started', false]);
    expect(unread?.problems).toEqual([expect.stringContaining('github.com/o/r#11 has more than 100 cross-references')]);
    expect(lines.find(line => line.row === '12-outside')?.status).toBe('completed');
    expect(checks[0].checks.finished.ok).toBe(false);
  });

  it('fails the batch when a trust: outside row runs an agent node', () => {
    const { run } = bench({ outsideAgentRuns: true });
    const { status, checks } = run('base');
    expect(status).toBe(1);
    expect(checks[0].checks.outside_agent.problems).toEqual(['base 12-outside: triage__triage ran']);
  });
});

describe('hard checks', () => {
  const facts = { labels: ['bug'], state: 'open', title: 't', body_digest: 'd', comments: 0 };
  const before: Snapshot = { issues: { 'github.com/o/r#1': facts }, state: { 'o/r': { 'work/1': 2 } } };

  it('name a new or revised state document and a posted comment', () => {
    const after: Snapshot = { issues: { 'github.com/o/r#1': { ...facts, comments: 1 } }, state: { 'o/r': { 'work/1': 3, 'work/2': 1 } } };
    expect(snapshotChanges(before, after)).toEqual([
      'github.com/o/r#1: comments changed from 0 to 1',
      'state o/r/work/1: revision 2 became 3',
      'state o/r/work/2: revision none became 1',
    ]);
    expect(postedComments(before, after)).toEqual(['github.com/o/r#1: 1 comment(s) posted']);
    expect([snapshotChanges(before, before), postedComments(before, before)]).toEqual([[], []]);
  });

  it('fail the batch on a posted comment', () => {
    const context = { set: { bench: 'intake', repo: REPO, selected_at: '', rows: [] }, batch: 1, batchRun: '1-x', base: 'c', outDir: '', views: new Map(), unread: new Map(), mergedOnBase: new Map() } as const;
    const checks = batchChecks(context, 'eval', ['a'], [], [], ['github.com/o/r#1: 1 comment(s) posted']);
    expect([checks.passed, checks.checks.posted_text]).toEqual([false, { ok: false, problems: ['github.com/o/r#1: 1 comment(s) posted'] }]);
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
    expect(findLookups(transcript, issueTokens(REPO, 4))).toEqual([
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
  it('do not flag a shell here-document that writes the report citing the issue', () => {
    const event = (body: Record<string, unknown>) => JSON.stringify({ type: 'provider_event', step: 'triage', event: body });
    const heredoc = "cat > /runs/1/triage.md <<'EOF'\n# Triage: o/r#4\nSee https://github.com/o/r/issues/4\nEOF\ncat /runs/1/triage.md";
    const transcript = [
      event({ type: 'subtask', taskId: 'command:t:1', taskType: 'command_execution', status: 'completed', description: `/bin/zsh -lc "mkdir -p /runs/1 && ${heredoc}"` }),
      event({ type: 'tool_call', toolCallId: 'a', name: 'Bash', rawInput: { command: heredoc } }),
      event({ type: 'tool_call', toolCallId: 'b', name: 'Bash', rawInput: { command: `gh issue view 4 > /tmp/i && ${heredoc}` } }),
    ].join('\n');
    expect(findLookups(transcript, issueTokens(REPO, 4))).toEqual(["triage: gh issue view 4 > /tmp/i && cat > /runs/1/triage.md <<'EOF'\ncat /runs/1/triage.md"]);
  });
  it('flags expanding cat and tee heredocs through tool calls and command subtasks', () => {
    for (const writer of ['cat > report', 'tee report']) {
      for (const delimiter of ['EOF', "'EOF'", '"EOF"', '\\EOF']) {
        const command = `${writer} <<${delimiter}\n$(curl https://github.com/o/r/issues/4)\nEOF`;
        for (const event of [
          { type: 'tool_call', toolCallId: 'a', rawInput: { command } },
          { type: 'subtask', taskId: 'a', taskType: 'command_execution', description: command },
        ]) {
          const found = findLookups(JSON.stringify({ type: 'provider_event', step: 'triage', event }), issueTokens(REPO, 4));
          expect(found).toHaveLength(delimiter === 'EOF' ? 1 : 0);
        }
      }
    }
  });

  it('flag a here-document that a command runs, and a lookup after a here-string', () => {
    const event = (id: string, command: string) => JSON.stringify({ type: 'provider_event', step: 'triage', event: { type: 'tool_call', toolCallId: id, name: 'Bash', rawInput: { command } } });
    const python = "python3 - <<'EOF'\nimport subprocess\nsubprocess.run(['gh', 'api', 'repos/o/r/issues/4'])\nEOF";
    const piped = 'cat <<EOF | bash\ngh issue view 4\nEOF';
    const herestring = 'cat <<< done\ngh issue view 4\nEOF';
    const transcript = [event('a', python), event('b', piped), event('c', herestring)].join('\n');
    expect(findLookups(transcript, issueTokens(REPO, 4))).toEqual([`triage: ${python}`, `triage: ${piped}`, `triage: ${herestring}`]);
  });
});

describe('outer shell expansion accounting', () => {
  it('flags escaped backticks executed by the inner shell through both transcript routes', () => {
    for (const argument of ['\\`curl https://github.com/o/r/issues/4\\`', '\\"\\`curl https://github.com/o/r/issues/4\\`\\"']) {
      const command = `bash -c "gh issue view 4 --json body --jq ${argument}"`;
      for (const event of [
        { type: 'tool_call', toolCallId: 'a', rawInput: { command } },
        { type: 'subtask', taskId: 'a', taskType: 'command_execution', description: command },
      ]) {
        const found = findLookups(JSON.stringify({ type: 'provider_event', step: 'triage', event }), issueTokens(REPO, 4));
        expect(found).toHaveLength(1);
        expect(splitLookups(found, true, [])).toEqual({ answered: [], leak: found });
      }
    }
  });

  it('keeps substitutions inert inside inner single quotes after removing outer escapes', () => {
    for (const argument of ['\\`curl https://github.com/o/r/issues/4\\`', '\\$(curl https://github.com/o/r/issues/4)']) {
      const lookup = `triage: bash -c "gh issue view 4 --json body --jq '${argument}'"`;
      expect(splitLookups([lookup], true, [])).toEqual({ answered: [lookup], leak: [] });
    }
  });

  it('flags substitutions inside double-quoted wrappers through both transcript routes', () => {
    for (const substitution of ['$(curl https://github.com/o/r/issues/4)', '`curl https://github.com/o/r/issues/4`']) {
      const command = `bash -c "gh issue view 4 --json body --jq '${substitution}'"`;
      for (const event of [
        { type: 'tool_call', toolCallId: 'a', rawInput: { command } },
        { type: 'subtask', taskId: 'a', taskType: 'command_execution', description: command },
      ]) {
        const found = findLookups(JSON.stringify({ type: 'provider_event', step: 'triage', event }), issueTokens(REPO, 4));
        expect(found).toHaveLength(1);
        expect(splitLookups(found, true, [])).toEqual({ answered: [], leak: found });
      }
    }
  });
});

describe('lookups', () => {
  const view = (number: number): CreationView => ({
    number,
    id: `I_${String(number)}`,
    url: `https://github.com/o/r/issues/${String(number)}`,
    title: `Issue ${String(number)} as opened`,
    body: 'As opened.',
    labels: ['bug'],
    created_at: '2026-10-01T10:00:00Z',
  });
  const views = new Map([[4, view(4)]]);
  const closedConnection = { nodes: [{ body: 'Fixed.' }], totalCount: 1 };

  it('rewrite each batch issue in an answer to its creation view, by node id or URL', () => {
    // gh issue view: IssueByNumber, the issue under an alias of data.repository.
    const byNumber = atCreation(
      { data: { repository: { hasIssuesEnabled: true, issue: { _archonBenchIssueId: 'I_4', __typename: 'Issue', number: 4, title: 'Now', body: 'Now.', state: 'CLOSED', stateReason: 'COMPLETED', closedAt: 'x', closed: true, updatedAt: 'later', labels: { nodes: [{ name: 'bug' }, { name: 'archon-ready' }], totalCount: 2 }, comments: closedConnection, milestone: { title: 'v1' } } } } },
      views
    );
    expect(byNumber.value).toEqual({
      data: {
        repository: {
          hasIssuesEnabled: true,
          issue: {
            __typename: 'Issue',
            number: 4,
            title: 'Issue 4 as opened',
            body: 'As opened.',
            state: 'OPEN',
            stateReason: null,
            closedAt: null,
            closed: false,
            updatedAt: '2026-10-01T10:00:00Z',
            labels: { nodes: [{ name: 'bug' }], totalCount: 1 },
            comments: { nodes: [], edges: [], totalCount: 0, pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } },
          },
        },
      },
    });
    expect([...byNumber.answered]).toEqual([4]);
    // A REST read, by its html_url; another issue in the same answer is left as it is.
    const rest = atCreation(
      [
        { number: 4, html_url: 'https://github.com/O/R/issues/4', state: 'closed', state_reason: 'completed', comments: 3, labels: [{ name: 'x' }], assignees: [{ login: 'm' }] },
        { number: 5, html_url: 'https://github.com/o/r/issues/5', state: 'closed' },
      ],
      views
    );
    expect(rest.value).toEqual([
      { number: 4, html_url: 'https://github.com/O/R/issues/4', state: 'open', state_reason: null, comments: 0, labels: [{ name: 'bug' }] },
      { number: 5, html_url: 'https://github.com/o/r/issues/5', state: 'closed' },
    ]);
    // Numbers without identity cannot establish which repository owns a search result.
    const search = atCreation({ data: { search: { nodes: [{ number: 4, state: 'CLOSED', title: 'Now' }, { number: 5, state: 'CLOSED', title: 'Other' }] } } }, views);
    expect(search.value).toEqual({ data: { search: { nodes: [{ number: 4, state: 'CLOSED', title: 'Now' }, { number: 5, state: 'CLOSED', title: 'Other' }] } } });
    // Outside the set's repository, a number alone names nothing.
    expect(atCreation({ data: { search: { nodes: [{ number: 4, state: 'CLOSED' }] } } }, views).answered.size).toBe(0);
  });

  it('identifies literal, aliased and variable selections without changing sibling issues, PRs or repositories', async () => {
    const query = `query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        judged: issue(number: $number) { body state }
        sibling: issue(number: 5) { body state }
        pr: pullRequest(number: $number) { body state }
      }
      elsewhere: repository(owner: "other", name: "repo") {
        issue(number: 4) { body state }
      }
    }`;
    const response = { data: {
      repository: {
        judged: { _archonBenchIssueId: 'I_4', body: 'Fixed', state: 'CLOSED' },
        sibling: { _archonBenchIssueId: 'I_5', body: 'Other issue', state: 'CLOSED' },
        pr: { body: 'Merged PR', state: 'MERGED' },
      },
      elsewhere: { issue: { _archonBenchIssueId: 'I_elsewhere_4', body: 'Another repo', state: 'CLOSED' } },
    } };
    const answer = await answerLookup(new Request('http://api.github.com/graphql', {
      method: 'POST', body: JSON.stringify({ query, variables: { owner: 'o', name: 'r', number: 4 } }),
    }), REPO, views, async (_url, init) => {
      const forwarded = JSON.parse(String(init.body)) as { query: string };
      expect(forwarded.query.match(/_archonBenchIssueId: id/g)).toHaveLength(3);
      expect(forwarded.query).toContain('pr: pullRequest(number: $number) { body state }');
      return Response.json(response);
    });
    expect(await answer.response.json()).toEqual({ data: {
      repository: {
        judged: { body: 'As opened.', state: 'OPEN' },
        sibling: { body: 'Other issue', state: 'CLOSED' },
        pr: { body: 'Merged PR', state: 'MERGED' },
      },
      elsewhere: { issue: { body: 'Another repo', state: 'CLOSED' } },
    } });
    expect(answer.answered).toEqual([4]);

    // A request to another repository alone must also strip the private identity.
    const other = await answerLookup(new Request('http://api.github.com/graphql', {
      method: 'POST', body: JSON.stringify({ query: '{ repository(owner: "other", name: "repo") { issue(number: 4) { state } } }' }),
    }), REPO, views, async () => Response.json({ data: { repository: { issue: { _archonBenchIssueId: 'I_other', state: 'CLOSED' } } } }));
    expect(await other.response.json()).toEqual({ data: { repository: { issue: { state: 'CLOSED' } } } });
    expect([other.answered, other.live]).toEqual([[], []]);
  });

  it('returns creation label edges and complete page metadata', async () => {
    for (const withEdges of [true, false]) {
      const query = `{ repository(owner: "o", name: "r") { issue(number: 4) { labels(first: 10) { ${withEdges ? 'edges { cursor node { name } }' : ''} pageInfo { hasNextPage hasPreviousPage startCursor endCursor } } } }`;
      const answer = await answerLookup(new Request('http://api.github.com/graphql', {
        method: 'POST', body: JSON.stringify({ query }),
      }), REPO, views, async () => Response.json({ data: { repository: { issue: {
        _archonBenchIssueId: 'I_4', labels: { ...(withEdges ? { edges: [{ cursor: 'live-cursor', node: { name: 'done' } }] } : {}), pageInfo: { hasNextPage: true, hasPreviousPage: false, startCursor: 'live-cursor', endCursor: 'live-cursor' } },
      } } } }));
      expect(await answer.response.json()).toEqual({ data: { repository: { issue: { labels: {
        ...(withEdges ? { edges: [{ cursor: expect.any(String), node: { name: 'bug' } }] } : {}), pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: expect.any(String), endCursor: expect.any(String) },
      } } } } });
      expect([answer.answered, answer.live]).toEqual([[4], []]);
    }
  });

  it('refuses partial creation-label pages rather than certifying a false snapshot', async () => {
    const twoLabels = new Map([[4, { ...view(4), labels: ['bug', 'area: cli'] }]]);
    for (const args of ['first: 1', 'last: 1', 'first: $limit', 'first: 10, after: "live-cursor"', 'last: 10, before: "live-cursor"']) {
      for (const selection of ['nodes { name }', 'edges { cursor node { name } }', 'pageInfo { hasNextPage startCursor endCursor }']) {
        const query = `query Page${args.includes('$limit') ? '($limit: Int)' : ''} { repository(owner: "o", name: "r") { issue(number: 4) { tags: labels(${args}) { ${selection} totalCount } } } }`;
        await expect(answerLookup(new Request('http://api.github.com/graphql', {
          method: 'POST', body: JSON.stringify({ query, variables: { limit: 1 } }),
        }), REPO, twoLabels, async () => Response.json({ data: { repository: { issue: {
          _archonBenchIssueId: 'I_4', tags: {
            ...(selection.startsWith('nodes') ? { nodes: [{ name: 'done' }] } : {}),
            ...(selection.startsWith('edges') ? { edges: [{ cursor: 'live-cursor', node: { name: 'done' } }] } : {}),
            ...(selection.startsWith('pageInfo') ? { pageInfo: { hasNextPage: true, startCursor: 'live-cursor', endCursor: 'live-cursor' } } : {}),
            totalCount: 5,
          },
        } } } }))).rejects.toThrow('the bench cannot answer a partial labels page from the creation snapshot');
      }
    }
  });

  it('projects only the selected operation and its reachable fragments', async () => {
    const query = 'query A { repository(owner: "o", name: "r") { issue(number: 4) { ...Body } } } query B { repository(owner: "o", name: "r") { issue(number: 4) { x: id } } } fragment Body on Issue { x: body }';
    for (const operationName of ['A', 'B']) {
      const answer = await answerLookup(new Request('http://api.github.com/graphql', {
        method: 'POST', body: JSON.stringify({ query, operationName }),
      }), REPO, views, async (_url, init) => {
        const forwarded = JSON.parse(String(init.body)) as { query: string; operationName: string };
        expect(forwarded.operationName).toBe(operationName);
        const bodyKey = /(\w+): body/.exec(forwarded.query)?.[1] ?? 'x';
        return Response.json({ data: { repository: { issue: {
          _archonBenchIssueId: 'I_4', [operationName === 'A' ? bodyKey : 'x']: operationName === 'A' ? 'Live body' : 'I_4',
        } } } });
      });
      expect(await answer.response.json()).toEqual({ data: { repository: { issue: { x: operationName === 'A' ? 'As opened.' : 'I_4' } } } });
      expect([answer.answered, answer.live]).toEqual([[4], []]);
    }
    const unselected = await answerLookup(new Request('http://api.github.com/graphql', {
      method: 'POST', body: JSON.stringify({ query: 'query A { viewer { login } } query B { repository(owner: "o", name: "r") { issue(number: 4) { id } } }', operationName: 'A' }),
    }), REPO, views, async () => new Response('not json'));
    expect([unselected.answered, unselected.live]).toEqual([[], []]);
  });

  it('recognizes selected canonical identity through node interfaces and aliases', async () => {
    for (const [field, identity] of [['id', 'I_4'], ['url', 'https://github.com/o/r/issues/4']]) {
      const selection = field === 'id' ? 'identity: id' : '... on UniformResourceLocatable { identity: url }';
      const query = `{ node(id: "I_4") { ${selection} ... on Closable { state } } }`;
      const answer = await answerLookup(new Request('http://api.github.com/graphql', {
        method: 'POST', body: JSON.stringify({ query }),
      }), REPO, views, async (_url, init) => {
        const forwarded = JSON.parse(String(init.body)) as { query: string };
        const identityKey = /(\w+): url/.exec(forwarded.query)?.[1] ?? 'identity';
        return Response.json({ data: { node: { [identityKey]: identity, state: 'CLOSED' } } });
      });
      expect(await answer.response.json()).toEqual({ data: { node: { identity, state: 'OPEN' } } });
      expect([answer.answered, answer.live]).toEqual([[4], []]);
    }
  });

  it('unions same-field selections from two Issue fragments', async () => {
    const query = '{ repository(owner: "o", name: "r") { issue(number: 4) { ...Names ...Count } } } fragment Names on Issue { labels(first: 10) { nodes { name } } } fragment Count on Issue { labels(first: 10) { totalCount } }';
    const answer = await answerLookup(new Request('http://api.github.com/graphql', {
      method: 'POST', body: JSON.stringify({ query }),
    }), REPO, views, async () => Response.json({ data: { repository: { issue: {
      _archonBenchIssueId: 'I_4', labels: { nodes: [{ name: 'done' }], totalCount: 7 },
    } } } }));
    expect(await answer.response.json()).toEqual({ data: { repository: { issue: { labels: { nodes: [{ name: 'bug' }], totalCount: 1 } } } } });
    expect([answer.answered, answer.live]).toEqual([[4], []]);
  });

  it('merges restored aliases on issues and unrelated objects', async () => {
    const query = `{ repository(owner: "o", name: "r") {
      owner { profile: avatarUrl profileOwner: login }
      who: owner { login }
      ...Repo
      issue(number: 4) { tags: labels(first: 10) { count: totalCount } ...Tags }
    } }
    fragment Repo on Repository { who: owner { avatarUrl } }
    fragment Tags on Issue { tags: labels(first: 10) { items: nodes { text: name ...Label } } }
    fragment Label on Label { text: name }`;
    const answer = await answerLookup(new Request('http://api.github.com/graphql', {
      method: 'POST', body: JSON.stringify({ query }),
    }), REPO, views, async (_url, init) => {
      const forwarded = JSON.parse(String(init.body)) as { query: string };
      const keyOf = (name: string) => new RegExp(`(_archonBenchIssueIdField\\w*): ${name}\\b`).exec(forwarded.query)?.[1] ?? 'missing';
      return Response.json({ data: { repository: {
        owner: { profile: 'avatar', profileOwner: 'operator' },
        who: { login: 'operator' }, [keyOf('owner')]: { avatarUrl: 'avatar' },
        issue: { _archonBenchIssueId: 'I_4', tags: { count: 7 }, [keyOf('labels')]: { [keyOf('nodes')]: [{ [keyOf('name')]: 'done' }] } },
      } } });
    });
    expect(await answer.response.json()).toEqual({ data: { repository: {
      owner: { profile: 'avatar', profileOwner: 'operator' }, who: { login: 'operator', avatarUrl: 'avatar' },
      issue: { tags: { count: 1, items: [{ text: 'bug' }] } },
    } } });
    expect([answer.answered, answer.live]).toEqual([[4], []]);
  });

  it('rewrites aliased issue fields by schema name and preserves caller-owned private aliases', async () => {
    const keptAliases = ['id', 'node_id', 'number', 'url', 'html_url', 'repository_url', '__typename', 'databaseId', 'author', 'user', 'author_association', 'authorAssociation', 'createdAt', 'created_at'];
    const query = `{ repository(owner: "o", name: "r") {
      issue(number: 4) { ${keptAliases.map(key => `${key}: body`).join(' ')} text: title status: state tags: labels(first: 10) { items: nodes { text: name } count: totalCount } }
      pullRequest(number: 4) { _archonBenchIssueId: id }
    } }`;
    const answer = await answerLookup(new Request('http://api.github.com/graphql', {
      method: 'POST', body: JSON.stringify({ query }),
    }), REPO, views, async (_url, init) => {
      const forwarded = JSON.parse(String(init.body)) as { query: string };
      const identity = /on Issue \{ (\w+): id/.exec(forwarded.query)?.[1];
      expect(identity).toBeDefined();
      return Response.json({ data: { repository: {
        issue: { [identity ?? 'missing']: 'I_4', ...Object.fromEntries(keptAliases.map(key => [key, 'Live outcome'])), text: 'Current title', status: 'CLOSED', tags: { items: [{ text: 'done' }], count: 1 } },
        pullRequest: { _archonBenchIssueId: 'PR_4' },
      } } });
    });
    expect(await answer.response.json()).toEqual({ data: { repository: {
      issue: { ...Object.fromEntries(keptAliases.map(key => [key, 'As opened.'])), text: 'Issue 4 as opened', status: 'OPEN', tags: { items: [{ text: 'bug' }], count: 1 } },
      pullRequest: { _archonBenchIssueId: 'PR_4' },
    } } });
    expect([answer.answered, answer.live]).toEqual([[4], []]);
  });

  it('keeps alias ownership separate across disjoint Issue and PR fragments', async () => {
    const query = '{ search(query: "repo:o/r", type: ISSUE, first: 10) { nodes { ... on Issue { id: body writer: author { name: login } } ... on PullRequest { id } } } }';
    const answer = await answerLookup(new Request('http://api.github.com/graphql', {
      method: 'POST', body: JSON.stringify({ query }),
    }), REPO, views, async (_url, init) => {
      const forwarded = JSON.parse(String(init.body)) as { query: string };
      const keyOf = (name: string) => new RegExp(`(\\w+): ${name}\\b`).exec(forwarded.query)?.[1] ?? 'missing';
      return Response.json({ data: { search: { nodes: [
        { _archonBenchIssueId: 'I_4', [keyOf('body')]: 'Live outcome', [keyOf('author')]: { [keyOf('login')]: 'opener' } },
        { id: 'PR_4' },
      ] } } });
    });
    expect(await answer.response.json()).toEqual({ data: { search: { nodes: [
      { id: 'As opened.', writer: { name: 'opener' } },
      { id: 'PR_4' },
    ] } } });
    expect([answer.answered, answer.live]).toEqual([[4], []]);
  });

  it('merges aliases inside a projected creation connection', async () => {
    const query = '{ repository(owner: "o", name: "r") { issue(number: 4) { labels(first: 10) { items: nodes { text: name } ...Connection } } } } fragment Connection on LabelConnection { items: nodes { name } }';
    const answer = await answerLookup(new Request('http://api.github.com/graphql', {
      method: 'POST', body: JSON.stringify({ query }),
    }), REPO, new Map([[4, { ...view(4), labels: ['bug', 'area: cli'] }]]), async (_url, init) => {
      const forwarded = JSON.parse(String(init.body)) as { query: string };
      const itemsKey = /(_archonBenchIssueIdField\w*): nodes/.exec(forwarded.query)?.[1] ?? 'missing';
      return Response.json({ data: { repository: { issue: { _archonBenchIssueId: 'I_4', labels: {
        items: [{ text: 'done' }, { text: 'later' }], [itemsKey]: [{ name: 'done' }, { name: 'later' }],
      } } } } });
    });
    expect(await answer.response.json()).toEqual({ data: { repository: { issue: { labels: { items: [{ text: 'bug', name: 'bug' }, { text: 'area: cli', name: 'area: cli' }] } } } } });
    expect([answer.answered, answer.live]).toEqual([[4], []]);
  });

  it('does not count issue syntax inside GraphQL strings or comments as a selection', async () => {
    for (const query of [
      '{ search(query: "issue(number: 4)", type: ISSUE, first: 1) { issueCount } }',
      '{ viewer { login } # issue(number: 4) { body }\n }',
    ]) {
      const answer = await answerLookup(new Request('http://api.github.com/graphql', {
        method: 'POST', body: JSON.stringify({ query }),
      }), REPO, views, async (_url, init) => {
        expect(JSON.parse(String(init.body)).query).toBe(query);
        return Response.json({ data: {} });
      });
      expect([answer.answered, answer.live]).toEqual([[], []]);
    }
  });

  it('identifies issueOrPullRequest only through the requested private identity', async () => {
    const answer = await answerLookup(new Request('http://api.github.com/graphql', {
      method: 'POST', body: JSON.stringify({ query: '{ repository(owner: "o", name: "r") { issueOrPullRequest(number: 4) { ... on Issue { body state } } } }' }),
    }), REPO, views, async (_url, init) => {
      const { query } = JSON.parse(String(init.body)) as { query: string };
      // The field selection itself must request identity, independently of Issue fragments.
      const identified = /issueOrPullRequest\(number: 4\) \{ \.\.\. on Issue \{ _archonBenchIssueId: id \}/.test(query);
      return Response.json({ data: { repository: { issueOrPullRequest: { ...(identified ? { _archonBenchIssueId: 'I_4' } : {}), body: 'Fixed', state: 'CLOSED' } } } });
    });
    expect(await answer.response.json()).toEqual({ data: { repository: { issueOrPullRequest: { body: 'As opened.', state: 'OPEN' } } } });
    expect([answer.answered, answer.live]).toEqual([[4], []]);
  });

  it('identifies issues in named and inline fragments used by search queries', async () => {
    for (const query of [
      'fragment issue on Issue { number state title } query { search(query: "repo:o/r", type: ISSUE, first: 10) { nodes { ...issue } } }',
      '{ search(query: "repo:o/r", type: ISSUE, first: 10) { nodes { ... on Issue @include(if: true) { number state title } } } }',
    ]) {
      const answer = await answerLookup(new Request('http://api.github.com/graphql', {
        method: 'POST', body: JSON.stringify({ query }),
      }), REPO, views, async (_url, init) => {
        const forwarded = JSON.parse(String(init.body)) as { query: string };
        expect(forwarded.query).toContain('_archonBenchIssueId: id');
        return Response.json({ data: { search: { nodes: [
          { _archonBenchIssueId: 'I_4', number: 4, state: 'CLOSED', title: 'Now' },
          { _archonBenchIssueId: 'I_other', number: 4, state: 'CLOSED', title: 'Other repository' },
        ] } } });
      });
      expect(await answer.response.json()).toEqual({ data: { search: { nodes: [
        { number: 4, state: 'OPEN', title: 'Issue 4 as opened' },
        { number: 4, state: 'CLOSED', title: 'Other repository' },
      ] } } });
      expect(answer.answered).toEqual([4]);
    }
  });

  it('forwards a PR-only query unchanged without treating its number as a batch issue read', async () => {
    const body = JSON.stringify({ query: 'query($number: Int!) { repository(owner: "o", name: "r") { pullRequest(number: $number) { state } } }', variables: { number: 4 } }, null, 2);
    const answer = await answerLookup(new Request('http://api.github.com/graphql', { method: 'POST', body }), REPO, views, async (_url, init) => {
      expect(init.body).toBe(body);
      return Response.json({ data: { repository: { pullRequest: { state: 'MERGED' } } } });
    });
    expect(await answer.response.json()).toEqual({ data: { repository: { pullRequest: { state: 'MERGED' } } } });
    expect([answer.answered, answer.live]).toEqual([[], []]);
  });

  it('answer a batch issue history locally and forward anything else unchanged', async () => {
    const calls: string[] = [];
    const upstream = async (url: string): Promise<Response> => {
      calls.push(url);
      return new Response('{"number": 5, "state":"closed"}', { headers: { 'content-type': 'application/json' } });
    };
    const comments = await answerLookup(new Request('http://api.github.com/repos/o/r/issues/4/comments', { headers: { host: 'api.github.com' } }), REPO, views, upstream);
    expect([await comments.response.json(), comments.answered, calls]).toEqual([[], [4], []]);
    const labels = await answerLookup(new Request('http://api.github.com/repos/o/r/issues/4/labels'), REPO, views, upstream);
    expect(await labels.response.json()).toEqual([{ name: 'bug' }]);
    const other = await answerLookup(new Request('http://api.github.com/repos/o/r/issues/5?x=1', { headers: { host: 'api.github.com' } }), REPO, views, upstream);
    expect([await other.response.text(), other.answered, calls]).toEqual(['{"number": 5, "state":"closed"}', [], ['https://api.github.com/repos/o/r/issues/5?x=1']]);
  });

  it('read the labels the author set at creation, not those added later or by others', () => {
    const at = (seconds: number) => new Date(Date.parse('2026-10-01T10:00:00Z') + seconds * 1000).toISOString();
    const events = [
      { createdAt: at(1), actor: 'a', label: 'bug', removed: false },
      { createdAt: at(2), actor: 'a', label: 'area: cli', removed: false },
      { createdAt: at(3), actor: 'a', label: 'area: cli', removed: true },
      { createdAt: at(5), actor: 'm', label: 'archon-ready', removed: false },
      { createdAt: at(14 * 3600), actor: 'a', label: 'enhancement', removed: false },
    ];
    expect(creationLabels('a', '2026-10-01T10:00:00Z', events)).toEqual(['bug']);
    expect(creationLabels(null, '2026-10-01T10:00:00Z', events)).toEqual([]);
  });

  it('count a gh lookup as answered only when the run reached the server, and a fetch never', () => {
    const lookups = ['triage: gh issue view 4 --repo o/r', 'triage: gh api repos/o/r/issues/4/events', 'triage: https://github.com/o/r/issues/4'];
    const wrapped = "triage: /bin/zsh -lc 'gh issue view 4 --repo o/r'";
    expect(splitLookups([wrapped], true, [])).toEqual({ answered: [wrapped], leak: [] });
    expect(splitLookups(lookups, true, [])).toEqual({ answered: lookups.slice(0, 2), leak: lookups.slice(2) });
    expect(splitLookups(lookups, false, [])).toEqual({ answered: [], leak: lookups });
    expect(splitLookups(lookups.slice(0, 1), true, ['POST /graphql'])).toEqual({ answered: lookups.slice(0, 1), leak: ['lookup server: POST /graphql was answered live'] });
  });

  it('keeps mixed commands flagged even when gh reached the snapshot server', () => {
    for (const separator of ['; ', ' && ', '\n', ' | ']) {
      const command = `triage: gh issue view 4${separator}curl https://github.com/o/r/issues/4`;
      expect(splitLookups([command], true, []).leak).toEqual([command]);
    }
  });

  it('keeps executable process substitutions flagged through both transcript routes', () => {
    for (const redirect of ['< <', '> >']) {
      const command = `gh issue view 4 ${redirect}(curl https://github.com/o/r/issues/4)`;
      for (const event of [
        { type: 'tool_call', toolCallId: 'lookup', rawInput: { command } },
        { type: 'subtask', taskType: 'command_execution', taskId: 'lookup', description: command },
      ]) {
        const transcript = JSON.stringify({ type: 'provider_event', step: 'triage', event });
        const lookups = findLookups(transcript, issueTokens(REPO, 4));
        expect(lookups).toHaveLength(1);
        expect(splitLookups(lookups, true, [])).toEqual({ answered: [], leak: lookups });
      }
    }
  });

  it('covers a single gh command whose quoted jq expression contains a pipe', () => {
    const command = "triage: gh issue view 4 --json body --jq '.body | length'";
    expect(splitLookups([command], true, [])).toEqual({ answered: [command], leak: [] });
  });

  it('preserves stored gh credentials in the socket configuration', () => {
    const operator = track(mkdtempSync(join(tmpdir(), 'bench-gh-auth-')));
    writeFileSync(join(operator, 'hosts.yml'), 'bench-auth.invalid:\n    oauth_token: bench-stored-token\n    user: bench-test\n    git_protocol: https\n');
    const previous = process.env.GH_CONFIG_DIR;
    process.env.GH_CONFIG_DIR = operator;
    const server = serveLookups({ ...REPO, host: 'bench-auth.invalid' }, views);
    try {
      const result = spawnSync('gh', ['auth', 'token', '--hostname', 'bench-auth.invalid'], {
        encoding: 'utf8',
        env: { ...process.env, ...server.env, GH_TOKEN: '', GITHUB_TOKEN: '', GH_ENTERPRISE_TOKEN: '', GITHUB_ENTERPRISE_TOKEN: '' },
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim() === 'bench-stored-token').toBe(true);
    } finally {
      server.stop();
      if (previous === undefined) delete process.env.GH_CONFIG_DIR;
      else process.env.GH_CONFIG_DIR = previous;
    }
  });

  it('does not rewrite another forge host, even with the same repository, number and id', async () => {
    for (const path of ['/repos/o/r/issues/4/comments', '/graphql']) {
      const upstream = async () => Response.json({ id: 'I_4', number: 4, state: 'CLOSED' });
      const result = await answerLookup(new Request(`http://enterprise.example${path}`, {
        method: path === '/graphql' ? 'POST' : 'GET',
        ...(path === '/graphql' ? { body: JSON.stringify({ query: '{ repository(owner: "o", name: "r") { issue(number: 4) { state } } }' }) } : {}),
      }), REPO, views, upstream);
      expect([await result.response.json(), result.answered, result.live]).toEqual([{ id: 'I_4', number: 4, state: 'CLOSED' }, [], []]);
    }
  });

  it('report a request that names a batch issue but is answered live', async () => {
    const upstream = async (_url: string, init: RequestInit): Promise<Response> => {
      const asked = JSON.parse(String(init.body)) as { query: string };
      const issue = { ...(asked.query.includes('_archonBenchIssueId') ? { _archonBenchIssueId: 'I_4' } : {}), state: 'CLOSED' };
      return Response.json({ data: { repository: { issue } } });
    };
    const graphql = (body: unknown) => new Request('http://api.github.com/graphql', { method: 'POST', headers: { host: 'api.github.com' }, body: JSON.stringify(body) });
    const scoped = await answerLookup(graphql({ query: 'query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { issue(number: $number) { state } } }', variables: { owner: 'o', repo: 'r', number: 4 } }), REPO, views, upstream);
    expect([scoped.answered, scoped.live]).toEqual([[4], []]);
    const literal = await answerLookup(graphql({ query: '{ repository(owner: "o", name: "r") { issue(number: 4) { state } } }' }), REPO, views, upstream);
    expect([await literal.response.json(), literal.answered, literal.live]).toEqual([{ data: { repository: { issue: { state: 'OPEN' } } } }, [4], []]);
    const rest = await answerLookup(new Request('http://api.github.com/repos/o/r/issues/4/reactions'), REPO, views, async () => Response.json([{ content: '+1' }]));
    expect([rest.answered, rest.live]).toEqual([[], [4]]);
    const refused = await answerLookup(graphql({ query: '{ repository(owner: "o", name: "r") { issue(number: 4) { projectItems { id } } } }' }), REPO, views, async () =>
      Response.json({ errors: [{ type: 'INSUFFICIENT_SCOPES' }] })
    );
    expect([refused.answered, refused.live]).toEqual([[], []]);
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

  it('excuses a close on an open row a merged base PR references, unless marked wrong', () => {
    const out = benchOut();
    const fixedOnBase = { merged_on_base: ['https://github.com/o/r/pull/40'] };
    appendLine(join(out, SAMPLES_FILE), line('b', typed, '1-x', fixedOnBase));
    const excused = score(set, out).versions[1];
    expect([excused.false_closes, excused.excused_closes]).toEqual([[], ['2']]);
    expect(renderScore(score(set, out))).toContain('0, 1 excused by a merged base PR (2): pass');
    expect(renderPage(set, out, 1)).toContain('A merged pull request on the base references this issue: <a href="https://github.com/o/r/pull/40">');
    appendLine(join(out, MARKS_FILE), { run_id: 'b-2-1-x', batch: 1, row: '2', label: 'b', mark: 'wrong', note: '' });
    expect([score(set, out).versions[1].false_closes, score(set, out).versions[1].excused_closes]).toEqual([['2'], []]);
  });

  it('lets a mark override the expected answer for closes and dispositions, but not for type', () => {
    const out = benchOut();
    expect(renderPage(set, out, 1)).toContain('Counts as a false close unless you mark it right.');
    appendLine(join(out, MARKS_FILE), { run_id: 'b-2-1-x', batch: 1, row: '2', label: 'b', mark: 'right', note: '' });
    const blocked = row(10, { group: 'dispositioned', known: { disposition: { contract: 'BLOCKED' } } });
    const ready = { verdict: { ...line('a', blocked, '2-y').verdict!, contract: 'READY' as const, route: 'plan' as const } };
    appendLine(join(out, SAMPLES_FILE), line('a', blocked, '2-y', ready));
    appendLine(join(out, SAMPLES_FILE), line('b', blocked, '2-y', { verdict: { ...ready.verdict, contract: 'BLOCKED', route: null } }));
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
    const out = benchOut();
    const result = score(set, out);
    expect(renderScore(result)).toContain('| every `trust: outside` row ran no agent node | 0 of 0 ran one: not applicable |');
    expect(result.versions[0].bars.not_planned.status).toBe('not applicable');
    const empty = track(mkdtempSync(join(tmpdir(), 'intake-bench-score-')));
    appendLine(join(empty, SAMPLES_FILE), line('a', fixed, '2-y'));
    appendLine(join(empty, CHECKS_FILE), checks('2-y', true));
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
