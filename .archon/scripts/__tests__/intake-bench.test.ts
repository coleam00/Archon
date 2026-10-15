/**
 * The intake bench's own invariants, each one whose failure would silently corrupt its
 * numbers or its trust proof: a version that cannot be pinned, a run judged on text
 * other than the pinned creation text, an unlabelled line, a write or an outside
 * agent that does not fail its batch, a stale or leaked line counted, and marks that
 * do not tally across batches.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { appendLine, readLines } from '../../workflows/sdlc/.shared/bench';
import { postMark, renderPage } from '../../workflows/sdlc/intake/scripts/bench/page';
import {
  type BatchChecks,
  CHECKS_FILE,
  checkScratch,
  loadLive,
  findLeaks,
  issueTokens,
  type Line,
  SAMPLES_FILE,
  type Version,
} from '../../workflows/sdlc/intake/scripts/bench/runner';
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
    expect(lines.find(line => line.row === '12-outside')?.agent_nodes).toEqual([]);
    expect(checks).toHaveLength(1);
    expect(checks[0].passed).toBe(true);
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

  it('runs intake live on the version scratch copies and reads the verdict from the copy work item', () => {
    const { runWith, argv, repo, out, cli } = bench();
    const scratch = track(mkdtempSync(join(tmpdir(), 'intake-bench-scratch-')));
    ok(scratch, 'clone', '-q', repo, '.');
    ok(scratch, 'remote', 'set-url', 'origin', 'git@github.com:me/scratch-base.git');
    writeFileSync(join(out, 'live.yaml'), JSON.stringify({ base: { repo: { host: 'github.com', path: 'me/scratch-base' }, checkout: scratch } }));
    mkdirSync(join(out, 'bench', 'live'), { recursive: true });
    writeFileSync(join(out, 'bench', 'live', 'base.json'), JSON.stringify({ repo: { host: 'github.com', path: 'me/scratch-base' }, copies: { '11': 101, '12-outside': 102 } }));
    const config = JSON.parse(readFileSync(join(cli, 'config.json'), 'utf8')) as FakeConfig;
    config.issues.push({ number: 101, labels: [], comments: 0 }, { number: 102, labels: [], comments: 0 });
    writeFileSync(join(cli, 'config.json'), JSON.stringify(config));

    const { status, stderr, lines, checks } = runWith(['--live', join(out, 'live.yaml')], 'base');
    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(argv(1)).toEqual(expect.arrayContaining(['archon-intake', scratch, 'repo_path=me/scratch-base', 'number=101', 'mode=live', 'trust=auto']));
    const live = lines.find(line => line.row === '11');
    expect([live?.mode, live?.workflow, live?.verdict?.contract, live?.verdict?.route, live?.verdict?.summary]).toEqual(['live', 'intake', 'READY', 'plan', undefined]);
    expect(checks[0]).toMatchObject({ mode: 'live', passed: true });
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

  it('does not pass a run whose judging node recorded no model binding', () => {
    const { run } = bench({ unboundTriage: true });
    const { lines } = run('base');
    expect(lines.find(line => line.row === '11')).toMatchObject({
      passed: false,
      problems: ['triage recorded no model binding, so its version is unproven'],
    });
  });

  it('fails the batch when an eval run writes to an issue', () => {
    const { run } = bench({ writeLabel: 'archon-ready' });
    const { status, stderr, checks } = run('base');
    expect(status).toBe(1);
    expect(checks[0].passed).toBe(false);
    expect(checks[0].checks.writes.problems).toEqual(expect.arrayContaining([expect.stringContaining('github.com/o/r#12: labels changed')]));
    expect(stderr).toContain('FAILED its hard checks');
  });

  it('fails the batch when a trust: outside row runs an agent node', () => {
    const { run } = bench({ outsideAgentRuns: true });
    const { status, checks } = run('base');
    expect(status).toBe(1);
    expect(checks[0].checks.outside_agent.problems).toEqual(['base 12-outside: triage__triage ran']);
  });
});

describe('leaks', () => {
  it('flag a tool call that names the judged issue, and nothing else', () => {
    const call = (title: string, rawInput: unknown) =>
      JSON.stringify({ type: 'provider_event', step: 'triage', event: { type: 'tool_call', toolCallId: 'a', name: 'Bash', title, rawInput } });
    const transcript = [
      call('gh issue view 41', { command: 'gh issue view 41' }),
      call('gh issue view 4', { command: 'gh issue view 4 --repo o/r' }),
      call('Read', { url: 'https://github.com/o/r/issues/4#issuecomment-1' }),
      JSON.stringify({ type: 'provider_event', step: 'triage', event: { type: 'text', text: 'issues/4' } }),
    ].join('\n');
    expect(findLeaks(transcript, issueTokens(REPO, 4))).toEqual(['triage: gh issue view 4', 'triage: Read']);
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
