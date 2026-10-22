import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  blocksPass,
  evidenceProblems,
  filesReadInLog,
  isTrackingIssue,
  parseDispositions,
  parseJudgeChanges,
  readAppCheck,
  recordRefusals,
  shipFailuresInLog,
  untestedMerge,
  type CheckLine,
  type CitedFile,
  type Proofs,
} from '../../workflows/sdlc/.shared/merge-gate';

const pack = resolve(import.meta.dir, '../../workflows/sdlc');
const STARTED = 1_000_000;
const fresh: CitedFile = { exists: true, mtimeMs: STARTED + 5000, opened: true };

function line(id: string, kind: CheckLine['kind'], verdict: string, more: Partial<CheckLine> = {}): CheckLine {
  return { id, kind, verdict, text: `${id} text`, evidence: [`/run/${id.toLowerCase()}.txt`], pre_existing: '', defect: '', carried_from: '', ...more };
}

const CLEAN_LINES = [
  line('C1', 'criterion', 'PASS'),
  line('H1', 'holdout', 'PASS', { evidence: ['/run/h1.txt', '/run/h1.png'] }),
  line('P1', 'probe', 'OK', { evidence: ['/run/p1.png'] }),
];

/** A structured report as the check-app node returns it, with lines replaced or added by id. */
function report(lines: CheckLine[] = [], overall = 'PASS'): string {
  const byId = new Map(CLEAN_LINES.map(l => [l.id, l]));
  for (const l of lines) byId.set(l.id, l);
  return JSON.stringify({ pr: 'https://github.com/o/r/pull/9', head: 'abc1234', merged_with: 'def5678', lines: [...byId.values()], overall, summary: '' });
}

const CLEAN = report();
const disp = (...entries: Record<string, string>[]): ReturnType<typeof parseDispositions> => parseDispositions(JSON.stringify(entries));

function gate(json: string, extra: Partial<Parameters<typeof recordRefusals>[0]> = {}): string[] {
  return recordRefusals({
    report: readAppCheck(json),
    evidenceProblems: [],
    dispositions: new Map(),
    shipFailures: [],
    judgeChanges: [],
    freshFile: () => false,
    issueExists: () => false,
    ...extra,
  });
}

const proven: Proofs = { namesFile: () => true, earlierCommit: () => true };
const problems = (json: string, look: (path: string) => CitedFile = () => fresh, proofs: Proofs = proven): string[] =>
  evidenceProblems(readAppCheck(json), STARTED, look, proofs);

describe('evidence check', () => {
  it('a clean report with fresh, opened evidence passes', () => {
    expect(problems(CLEAN)).toEqual([]);
  });

  it('a line that cites nothing, or a file that is not there, fails', () => {
    expect(problems(report([line('C1', 'criterion', 'PASS', { evidence: [] })]))).toEqual(['C1 cites no evidence']);
    expect(problems(CLEAN, path => (path === '/run/c1.txt' ? { exists: false, mtimeMs: 0, opened: null } : fresh))).toEqual([
      'C1 cites /run/c1.txt, which does not exist',
    ]);
  });

  it('a file written before the check began is not this check’s evidence', () => {
    expect(problems(CLEAN, path => (path === '/run/c1.txt' ? { ...fresh, mtimeMs: STARTED - 60_000 } : fresh))).toEqual([
      'C1 cites /run/c1.txt, written before this check began',
    ]);
  });

  it('an image cited but never opened is not evidence (seen live: North Star #399 screenshots)', () => {
    const look = (path: string): CitedFile => (path.endsWith('.png') ? { ...fresh, opened: false } : fresh);
    expect(problems(CLEAN, look)).toEqual([
      'H1 cites the image /run/h1.png, which the app check never opened',
      'P1 cites the image /run/p1.png, which the app check never opened',
    ]);
    // Without a run log nothing can say, so the rule does not apply.
    expect(problems(CLEAN, () => ({ ...fresh, opened: null }))).toEqual([]);
  });

  it('Overall PASS over a new defect is refused (the observed defect graded PASS)', () => {
    const lines = [line('P2', 'probe', 'SURPRISE', { defect: 'D1' }), line('D1', 'defect', 'DEFECT')];
    expect(problems(report(lines))).toEqual(['Overall says PASS over D1']);
    expect(problems(report(lines, 'FAIL'))).toEqual([]);
  });

  it('a probe surprise must name its defect line', () => {
    expect(problems(report([line('P2', 'probe', 'SURPRISE')]))).toEqual(['P2 is a surprise that names no defect line']);
  });

  it('a holdout the default branch cannot finish either leaves Overall PASS standing (seen live: #400 H2)', () => {
    const shared = line('H2', 'holdout', 'INCOMPLETE', { pre_existing: 'default-branch run under the same load: /run/main-h2.txt' });
    expect(problems(report([shared]))).toEqual([]);
    expect(problems(report([{ ...shared, pre_existing: '' }]))).toEqual(['Overall says PASS over H2']);
  });

  it('a carried line needs no new evidence; NO PR needs none at all', () => {
    expect(problems(report([line('C1', 'criterion', 'PASS', { evidence: [], carried_from: '0123abcd' })]))).toEqual([]);
    expect(problems(JSON.stringify({ pr: '', head: '', merged_with: '', lines: [], overall: 'NO PR', summary: 'nothing pushed' }))).toEqual([]);
  });

  it('an unreadable report never passes', () => {
    expect(problems('not json')).toEqual(['the report has no lines']);
  });

  it('reads which files the app check opened from the run log', () => {
    const log = [
      JSON.stringify({ step: 'check-app', type: 'provider_event', event: { type: 'tool_call', name: 'Read', rawInput: { file_path: 'C:\\run\\shot.png' } } }),
      JSON.stringify({ step: 'review', type: 'provider_event', event: { type: 'tool_call', name: 'Read', rawInput: { file_path: 'C:\\run\\other.png' } } }),
      '{"partial',
    ].join('\n');
    const key = (path: string): string => path.replace(/\\/g, '/').toLowerCase();
    expect([...filesReadInLog(log, 'check-app', key)]).toEqual(['c:/run/shot.png']);
  });
});

describe('merge gate', () => {
  const defect = report([line('D1', 'defect', 'DEFECT')], 'FAIL');

  it('a clean, evidenced report merges', () => {
    expect(gate(CLEAN)).toEqual([]);
  });

  it('an evidence check that failed refuses the merge', () => {
    expect(gate(CLEAN, { evidenceProblems: ['C1 cites no evidence'] })).toEqual([
      "the app check's report did not hold up: C1 cites no evidence",
    ]);
  });

  it('a new defect blocks unless the reviewer re-checked it with a file it wrote', () => {
    expect(gate(defect)).toEqual(['D1 (DEFECT) has no re-check or default-branch proof the reviewer wrote']);
    const claimed = disp({ line: 'd1', action: 'rechecked', file: '/run/review-d1.txt', issue: '', reason: '' });
    expect(gate(defect, { dispositions: claimed })).toHaveLength(1);
    expect(gate(defect, { dispositions: claimed, freshFile: path => path === '/run/review-d1.txt' })).toEqual([]);
  });

  it('a defect the reviewer shows is on the default branch needs a tracking issue too', () => {
    const noIssue = disp({ line: 'D1', action: 'pre-existing', file: '/run/main.txt', issue: '', reason: '' });
    expect(gate(defect, { dispositions: noIssue, freshFile: () => true })).toEqual([
      "D1 is pre-existing by the reviewer's run, but no issue that exists tracks it",
    ]);
    const tracked = disp({ line: 'D1', action: 'pre-existing', file: '/run/main.txt', issue: '#41', reason: '' });
    expect(gate(defect, { dispositions: tracked, freshFile: () => true, issueExists: ref => ref === '#41' })).toEqual([]);
  });

  it('a failure the default branch already has merges only with an issue that exists', () => {
    const json = report([line('H1', 'holdout', 'FAIL', { pre_existing: 'baseline row 2' })]);
    expect(gate(json)).toEqual(['H1 is a failure the default branch has too, but no issue that exists tracks it']);
    // Seen live: the reviewer named the issue under either action; the issue is what counts.
    for (const action of ['issue', 'pre-existing']) {
      const linked = disp({ line: 'H1', action, file: '', issue: '#12', reason: '' });
      expect(gate(json, { dispositions: linked })).toHaveLength(1);
      expect(gate(json, { dispositions: linked, issueExists: ref => ref === '#12' })).toEqual([]);
    }
  });

  it('a failed criterion is never pre-existing (seen live: North Star #399 C2)', () => {
    const json = report([line('C1', 'criterion', 'FAIL', { pre_existing: 'the default branch lacks it too' })], 'FAIL');
    expect(blocksPass(readAppCheck(json).lines[0])).toBe(true);
    const unmet = 'C1 (FAIL): a criterion of this work item is not met. Deliver it in this pull request, or ask the owner to narrow the work item';
    const preExisting = disp({ line: 'C1', action: 'pre-existing', file: '/run/main.txt', issue: '#404', reason: '' });
    expect(gate(json, { dispositions: preExisting, freshFile: () => true, issueExists: () => true })).toEqual([unmet]);
    const blocks = disp({ line: 'C1', action: 'blocks', file: '', issue: '', reason: '' });
    expect(gate(json, { dispositions: blocks, freshFile: () => true })).toEqual([unmet]);
    // The reviewer's own re-check showing it met still clears it.
    const rechecked = disp({ line: 'C1', action: 'rechecked', file: '/run/recheck.md', issue: '', reason: '' });
    expect(gate(json, { dispositions: rechecked, freshFile: () => true })).toEqual([]);
  });

  it('a shipping pipeline whose review step failed never merges (the #362 case)', () => {
    const log = [
      JSON.stringify({ step: 'ship__deliver__review__code', type: 'node_complete' }),
      JSON.stringify({ step: 'ship__deliver__review__synthesize', type: 'node_error', error: 'the artifact pointer at $.report refers to a file that does not exist' }),
      JSON.stringify({ step: 'check-app', type: 'node_error', error: 'not a ship node' }),
    ].join('\n');
    const failures = shipFailuresInLog(log);
    expect(failures).toEqual(['ship__deliver__review__synthesize: the artifact pointer at $.report refers to a file that does not exist']);
    expect(gate(CLEAN, { shipFailures: failures })).toEqual([`the shipping pipeline's ${failures[0]} failed`]);
  });

  it('a question does not fail the check, but the review must decide it', () => {
    const json = report([line('D1', 'defect', 'QUESTION')]);
    expect(problems(json)).toEqual([]);
    expect(gate(json)).toEqual(['D1 is an open question the review did not decide (an issue, or accepted with a reason)']);
    expect(gate(json, { dispositions: disp({ line: 'D1', action: 'accepted', file: '', issue: '', reason: 'fine' }) })).toHaveLength(1);
    const reasoned = disp({ line: 'D1', action: 'accepted', file: '', issue: '', reason: 'a locked note cannot be saved, so nothing savable is lost' });
    expect(gate(json, { dispositions: reasoned })).toEqual([]);
    const filed = disp({ line: 'D1', action: 'issue', file: '', issue: '#60', reason: '' });
    expect(gate(json, { dispositions: filed, issueExists: ref => ref === '#60' })).toEqual([]);
  });

  it('a disposition that quotes the whole report line is matched by its id (seen live)', () => {
    const quoted = disp({ line: 'D1 NEW Export leaves out a note’s locked state', action: 'blocks', file: '', issue: '', reason: '' });
    expect([...quoted.keys()]).toEqual(['D1']);
    expect(disp({ line: 'D12 x', action: 'issue', file: '', issue: '#1', reason: '' }).has('D12')).toBe(true);
  });

  it('a line the evidence check flagged is cleared only by the reviewer’s own re-check', () => {
    const flagged = ['C1 cites /run/town.png, which does not exist', 'H1 cites /run/h1.txt, which does not exist'];
    const recheck = (id: string): Record<string, string> => ({ line: id, action: 'rechecked', file: '/run/recheck.md', issue: '', reason: '' });
    const base = { evidenceProblems: flagged, dispositions: disp(recheck('C1'), recheck('H1')) };
    expect(gate(CLEAN, { ...base, freshFile: () => true })).toEqual([]);
    expect(gate(CLEAN, { ...base, freshFile: () => false })).toHaveLength(1);
    expect(gate(CLEAN, { ...base, dispositions: disp(recheck('C1')), freshFile: () => true })).toEqual([
      `the app check's report did not hold up: ${flagged[1]}`,
    ]);
    // A problem with the report as a whole has no re-check that clears it.
    expect(gate(CLEAN, { ...base, evidenceProblems: ['Overall says PASS over D1'], freshFile: () => true })).toHaveLength(1);
  });

  it('malformed dispositions are ignored, never trusted', () => {
    expect(parseDispositions('not json').size).toBe(0);
    expect(parseDispositions('{"line":"D1"}').size).toBe(0);
    expect(parseDispositions('[null, {"line": 3}, {"line":"h1","action":"issue","issue":"#2"}]').get('H1')).toEqual({
      action: 'issue',
      file: '',
      issue: '#2',
      reason: '',
    });
  });
});

describe('what the record proves (2026-10-19 audit)', () => {
  it('a default-branch failure must name the file that shows it', () => {
    const json = report([line('H2', 'holdout', 'FAIL', { pre_existing: 'yes' })]);
    expect(problems(json, () => fresh, { ...proven, namesFile: () => false })).toEqual([
      'H2 says the default branch fails the same way but names no file that shows it',
    ]);
    expect(problems(json)).toEqual([]);
  });

  it('a carried line must come from an earlier commit of the tested head', () => {
    const json = report([line('C1', 'criterion', 'PASS', { evidence: [], carried_from: 'x' })]);
    expect(problems(json, () => fresh, { ...proven, earlierCommit: sha => sha !== 'x' })).toEqual([
      'C1 is carried from x, which is not an earlier commit of the tested head',
    ]);
  });

  it('only an open issue tracks anything: not a pull request, not a closed issue', () => {
    expect(isTrackingIssue({ state: 'OPEN', url: 'https://github.com/o/r/issues/12' })).toBe(true);
    expect(isTrackingIssue({ state: 'MERGED', url: 'https://github.com/o/r/pull/409' })).toBe(false);
    expect(isTrackingIssue({ state: 'OPEN', url: 'https://github.com/o/r/pull/430' })).toBe(false);
    expect(isTrackingIssue({ state: 'CLOSED', url: 'https://github.com/o/r/issues/12' })).toBe(false);
  });

  it('the merged commit must be what the check tested, or that plus a clean merge of the base away from this change', () => {
    const facts = { shaTree: 't1', testedTree: 't1', withBaseTree: 't2', fromBase: ['b.cs'], prFiles: ['a.cs'] };
    expect(untestedMerge(facts)).toBeNull();
    expect(untestedMerge({ ...facts, shaTree: 't2' })).toBeNull();
    expect(untestedMerge({ ...facts, shaTree: 't3' })).toContain('not what the app check tested');
    expect(untestedMerge({ ...facts, shaTree: 't2', fromBase: ['a.cs'] })).toContain('a.cs');
    expect(untestedMerge({ ...facts, shaTree: 't2', withBaseTree: '' })).toContain('not what the app check tested');
    expect(untestedMerge({ ...facts, testedTree: '' })).toContain('did not record');
  });

  it('a ship step that failed and then completed on resume is not a failure', () => {
    const log = [
      JSON.stringify({ step: 'ship__deliver__pr__publish', type: 'node_error', error: 'bad escape' }),
      JSON.stringify({ step: 'ship__deliver__pr__publish', type: 'node_complete' }),
      JSON.stringify({ step: 'ship__deliver__review__code', type: 'node_error', error: 'crashed' }),
    ].join('\n');
    expect(shipFailuresInLog(log)).toEqual(['ship__deliver__review__code: crashed']);
  });

  it('a change to what a check judges needs an approval named', () => {
    const changes = parseJudgeChanges(
      JSON.stringify([
        { file: 'game/harness/AllegianceCheck.cs', change: 'ghost pixels left out of foe samples', approval: '' },
        { file: 'game/harness/SceneryViewCheck.cs', change: 'new check', approval: 'C1' },
      ])
    );
    expect(gate(CLEAN, { judgeChanges: changes })).toEqual([
      'game/harness/AllegianceCheck.cs changes what a check judges (ghost pixels left out of foe samples) with no approval named',
    ]);
    expect(parseJudgeChanges('not json')).toEqual([]);
  });
});

describe('loop wiring', () => {
  // A Windows checkout carries CRLF; the node boundaries below are matched on LF.
  const yaml = readFileSync(resolve(pack, 'loop/archon-loop.yaml'), 'utf8').replace(/\r\n/g, '\n');
  const node = (id: string): string => {
    const start = yaml.indexOf(`  - id: ${id}\n`);
    const next = yaml.indexOf('\n  - id: ', start + 1);
    expect(start).toBeGreaterThan(-1);
    return yaml.slice(start, next === -1 ? undefined : next);
  };

  it('the app check is given facts, never the builder report or the shipping summary', () => {
    const checkApp = node('check-app');
    expect(checkApp).not.toContain('$build.output');
    expect(checkApp).not.toContain('$ship.output');
    expect(checkApp).toContain('output_format');
    const prompt = readFileSync(resolve(pack, 'loop/commands/loop-check-app.md'), 'utf8');
    expect(prompt).not.toContain('$INPUTS.builder');
    expect(prompt).not.toContain('$INPUTS.ship');
    expect(prompt).toContain('## How deep: $INPUTS.depth');
    expect(prompt).toContain('`noticed`');
    expect(prompt).not.toContain('When unsure, test more');
    expect(prompt).toContain('QUESTION');
    expect(prompt).toContain("What the default\nbranch brought in is not this change's");
    expect(prompt).toContain('change no code at all (only the pull request');
  });

  it('a lap that changes no code checks nothing again, and pick follows the critical path', () => {
    const work = readFileSync(resolve(pack, 'loop/commands/loop-work.md'), 'utf8');
    expect(work).toContain('A run that changes no code runs no checks either');
    expect(work).toContain('a green CI run on the commit you push is that full run');
    const pick = readFileSync(resolve(pack, 'loop/commands/loop-pick.md'), 'utf8');
    expect(pick).toContain('that unblocks the most other open work');
    expect(pick).toContain('asked for no code change (only the record, the evidence, or merging the default branch) is `light`');
    expect(pick).not.toContain('lowest number first unless');
  });

  it('the merge goes through the gate: review decides, land merges, deploy follows land', () => {
    expect(node('evidence')).toContain('script: evidence');
    expect(node('land')).toContain('script: land');
    expect(node('land')).toContain("$review.output.outcome == 'merge'");
    expect(node('deploy')).toContain("$land.output.outcome == 'merged'");
    const review = readFileSync(resolve(pack, 'loop/commands/loop-review.md'), 'utf8');
    expect(review).toContain('Never run `gh pr merge` yourself');
    expect(review).not.toMatch(/gh pr merge <n> --squash/);
  });

  it('shared pack text names no particular wrapper around Archon', () => {
    for (const file of ['manager/commands/manage.md', 'loop/commands/loop-review.md', 'loop/commands/loop-check-app.md']) {
      expect(readFileSync(resolve(pack, file), 'utf8')).not.toMatch(/consumer\.py|factory\//);
    }
  });

  it('the manager runs the holdouts once per pass, not again each time the default branch moves', () => {
    const manage = readFileSync(resolve(pack, 'manager/commands/manage.md'), 'utf8');
    expect(manage).toContain('When the default branch moves during your pass, do not rerun anything');
  });
});
