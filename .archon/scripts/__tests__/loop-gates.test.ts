import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseAppCheck } from '../../workflows/sdlc/.shared/app-check-report';
import { evidenceResolver } from '../../workflows/sdlc/.shared/evidence-files';
import {
  evidenceProblems,
  filesReadInLog,
  parseDispositions,
  recordRefusals,
  shipFailuresInLog,
  type CitedFile,
} from '../../workflows/sdlc/.shared/merge-gate';

const pack = resolve(import.meta.dir, '../../workflows/sdlc');
const STARTED = 1_000_000;
const fresh: CitedFile = { exists: true, mtimeMs: STARTED + 5000, opened: true };

const CLEAN = `APP CHECK https://github.com/o/r/pull/9 at abc1234 merged with main at def5678
C1 PASS  saves a note  POST /notes returned 201  [evidence: c1-post.txt]
H1 PASS  notes-survive-restart  the note is still listed after a restart  [evidence: h1.txt, h1.png]
PROBES
P1 OK  empty list / open the filter menu: the menu opens with no options  [evidence: p1.png]
DEFECTS SEEN: none
Overall: PASS`;

function gate(report: string, extra: Partial<Parameters<typeof recordRefusals>[0]> = {}): string[] {
  return recordRefusals({
    report: parseAppCheck(report),
    evidenceOk: true,
    evidenceProblems: '',
    dispositions: new Map(),
    shipFailures: [],
    reviewerFile: () => false,
    issueExists: () => false,
    ...extra,
  });
}

describe('app check report', () => {
  it('reads every line shape the prompt documents', () => {
    const report = parseAppCheck(
      `${CLEAN.replace('DEFECTS SEEN: none', 'DEFECTS SEEN\nD1 PRE-EXISTING (holdout-baseline.md 2026-10-17 H3)  the panel covers the map  [evidence: d1.png]')}\nH2 FAIL (pre-existing: holdout-baseline.md 2026-10-17 row 4)  h-two  slow at start  [evidence: h2.txt]\nC2 PASS (carried from 0123abcd)  older criterion`
    );
    expect(report.pr).toBe('https://github.com/o/r/pull/9');
    expect(report.commit).toBe('abc1234');
    expect(report.overall).toBe('PASS');
    const byId = Object.fromEntries(report.lines.map(line => [line.id, line]));
    expect(byId.H1.evidence).toEqual(['h1.txt', 'h1.png']);
    expect(byId.D1.verdict).toBe('PRE-EXISTING');
    expect(byId.H2.qualifier).toBe('pre-existing: holdout-baseline.md 2026-10-17 row 4');
    expect(byId.C2.carriedFrom).toBe('0123abcd');
  });

  it('finds cited files where the report says they are (seen live: evidence in a subfolder)', () => {
    const artifacts = mkdtempSync(join(tmpdir(), 'evidence-'));
    mkdirSync(join(artifacts, 'appcheck', 'normal'), { recursive: true });
    writeFileSync(join(artifacts, 'appcheck', 'town.png'), 'x');
    writeFileSync(join(artifacts, 'appcheck', 'normal', 'spawn.png'), 'x');
    writeFileSync(join(artifacts, 'top.txt'), 'x');
    const report = parseAppCheck(`Evidence directory: \`${join(artifacts, 'appcheck')}\`\nC1 PASS  x  y  [evidence: town.png]`);
    expect(report.evidenceDir).toBe(join(artifacts, 'appcheck'));
    const withProse = parseAppCheck(
      `Evidence directory: \`${join(artifacts, 'appcheck')}\`. The game ran in harness mode on port 8770.`
    );
    expect(withProse.evidenceDir).toBe(join(artifacts, 'appcheck'));
    const declared = evidenceResolver(artifacts, report.evidenceDir);
    expect(declared('town.png')).toBe(join(artifacts, 'appcheck', 'town.png'));
    expect(declared('top.txt')).toBe(join(artifacts, 'top.txt'));
    const undeclared = evidenceResolver(artifacts, '');
    expect(undeclared('normal/spawn.png')).toBe(join(artifacts, 'appcheck', 'normal', 'spawn.png'));
    expect(undeclared('missing.png')).toBeNull();
    expect(declared('town*.png')).toBe(join(artifacts, 'appcheck', 'town.png'));
    expect(declared('nothing-*.txt')).toBeNull();
    rmSync(artifacts, { recursive: true, force: true });
  });

  it('a path annotated by the agent is read as the path (seen live: "drive-diff.txt (0 bytes)")', () => {
    const report = parseAppCheck('C4 PASS  outputs match  identical  [evidence: drive-diff.txt (0 bytes), `run.log`]');
    expect(report.lines[0].evidence).toEqual(['drive-diff.txt', 'run.log']);
  });
});

describe('evidence check', () => {
  it('a clean report with fresh, opened evidence passes', () => {
    expect(evidenceProblems(parseAppCheck(CLEAN), STARTED, () => fresh)).toEqual([]);
  });

  it('a PASS that cites nothing, or a file that is not there, fails', () => {
    const report = parseAppCheck(CLEAN.replace('  [evidence: c1-post.txt]', ''));
    expect(evidenceProblems(report, STARTED, () => fresh)).toEqual(['C1 cites no evidence']);
    const missing = evidenceProblems(parseAppCheck(CLEAN), STARTED, cited =>
      cited === 'h1.txt' ? { exists: false, mtimeMs: 0, opened: false } : fresh
    );
    expect(missing).toEqual(['H1 cites h1.txt, which does not exist']);
  });

  it('a file written before the check began is not this check’s evidence', () => {
    const stale = evidenceProblems(parseAppCheck(CLEAN), STARTED, cited =>
      cited === 'c1-post.txt' ? { ...fresh, mtimeMs: STARTED - 60_000 } : fresh
    );
    expect(stale).toEqual(['C1 cites c1-post.txt, which was written before this check began']);
  });

  it('an image cited but never opened is not evidence', () => {
    const unopened = evidenceProblems(parseAppCheck(CLEAN), STARTED, cited =>
      cited === 'h1.png' ? { ...fresh, opened: false } : fresh
    );
    expect(unopened).toEqual(['H1 cites the image h1.png, which the app check never opened']);
  });

  it('Overall PASS over a new defect is refused (the observed defect graded PASS)', () => {
    const report = parseAppCheck(
      CLEAN.replace(
        'DEFECTS SEEN: none',
        'DEFECTS SEEN\nD1 NEW  walking into the shut gate carries the player through it  [evidence: d1.png]'
      )
    );
    expect(evidenceProblems(report, STARTED, () => fresh)).toEqual(['Overall says PASS over D1']);
  });

  it('a pre-existing holdout failure needs its citation to leave Overall PASS standing', () => {
    const cited = parseAppCheck(
      CLEAN.replace('H1 PASS  notes', 'H1 FAIL (pre-existing: baseline 2026-10-17 row 2)  notes')
    );
    expect(evidenceProblems(cited, STARTED, () => fresh)).toEqual([]);
    const bare = parseAppCheck(CLEAN.replace('H1 PASS  notes', 'H1 FAIL (pre-existing)  notes'));
    expect(evidenceProblems(bare, STARTED, () => fresh)).toEqual(['Overall says PASS over H1']);
    const deviated = parseAppCheck(CLEAN.replace('H1 PASS  notes', 'H1 INCOMPLETE  notes'));
    expect(evidenceProblems(deviated, STARTED, () => fresh)).toEqual(['Overall says PASS over H1']);
  });

  it('a probe surprise must name its defect line, and the defects section must be there', () => {
    const report = parseAppCheck(
      CLEAN.replace('P1 OK  empty list', 'P1 SURPRISE  empty list').replace('DEFECTS SEEN: none\n', '')
    );
    expect(evidenceProblems(report, STARTED, () => fresh)).toEqual([
      'P1 is a surprise with no DEFECTS SEEN line (write it as SURPRISE (D<n>))',
      'the report has no DEFECTS SEEN section (write "DEFECTS SEEN: none" when there are none)',
    ]);
  });

  it('a carried line needs no new evidence; NO PR needs none at all', () => {
    const carried = parseAppCheck(
      CLEAN.replace('C1 PASS  saves a note  POST /notes returned 201  [evidence: c1-post.txt]', 'C1 PASS (carried from 0123abcd)  saves a note')
    );
    expect(evidenceProblems(carried, STARTED, () => fresh)).toEqual([]);
    expect(evidenceProblems(parseAppCheck('NO PR nothing was pushed'), STARTED, () => fresh)).toEqual([]);
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
  it('a clean, evidenced report merges', () => {
    expect(gate(CLEAN)).toEqual([]);
  });

  it('an evidence check that failed refuses the merge', () => {
    expect(gate(CLEAN, { evidenceOk: false, evidenceProblems: 'C1 cites no evidence' })).toEqual([
      "the app check's report did not hold up: C1 cites no evidence",
    ]);
  });

  it('a new defect blocks unless the reviewer re-checked it with a file it wrote', () => {
    const report = CLEAN.replace('DEFECTS SEEN: none', 'DEFECTS SEEN\nD1 NEW  the menu opens off screen  [evidence: d1.png]').replace(
      'Overall: PASS',
      'Overall: FAIL (D1)'
    );
    expect(gate(report)).toEqual(['D1 (NEW) has no re-check or default-branch proof the reviewer wrote']);
    const claimed = parseDispositions(JSON.stringify([{ line: 'd1', action: 'rechecked', ref: 'review-d1.txt' }]));
    expect(gate(report, { dispositions: claimed })).toEqual([
      'D1 (NEW) has no re-check or default-branch proof the reviewer wrote',
    ]);
    expect(gate(report, { dispositions: claimed, reviewerFile: ref => ref === 'review-d1.txt' })).toEqual([]);
  });

  it('a defect the reviewer shows is on the default branch needs a tracking issue too', () => {
    const report = CLEAN.replace('DEFECTS SEEN: none', 'DEFECTS SEEN\nD1 NEW  the menu opens off screen  [evidence: d1.png]');
    const noIssue = parseDispositions(JSON.stringify([{ line: 'D1', action: 'pre-existing', ref: 'main-run.txt' }]));
    expect(gate(report, { dispositions: noIssue, reviewerFile: () => true })).toEqual([
      "D1 is pre-existing by the reviewer's run, but no issue that exists tracks it",
    ]);
    const tracked = parseDispositions(JSON.stringify([{ line: 'D1', action: 'pre-existing', ref: 'main-run.txt #41' }]));
    expect(gate(report, { dispositions: tracked, reviewerFile: () => true, issueExists: ref => ref === '#41' })).toEqual([]);
  });

  it('a failure the default branch already has merges only with an issue that exists', () => {
    const report = CLEAN.replace('H1 PASS  notes', 'H1 FAIL (pre-existing: baseline row 2)  notes');
    expect(gate(report)).toEqual(['H1 is a failure the default branch has too, but no issue that exists tracks it']);
    const linked = parseDispositions(JSON.stringify([{ line: 'H1', action: 'issue', ref: '#12' }]));
    expect(gate(report, { dispositions: linked, issueExists: () => false })).toHaveLength(1);
    expect(gate(report, { dispositions: linked, issueExists: () => true })).toEqual([]);
    // Seen live: the reviewer called it pre-existing with its own run and the issue.
    const named = parseDispositions(JSON.stringify([{ line: 'H1', action: 'pre-existing', ref: 'main-run.txt #12' }]));
    expect(gate(report, { dispositions: named, issueExists: ref => ref === '#12' })).toEqual([]);
  });

  it('a failed criterion cannot be dispositioned away with "blocks" and merged', () => {
    const report = CLEAN.replace('C1 PASS', 'C1 FAIL').replace('Overall: PASS', 'Overall: FAIL (C1)');
    const blocks = parseDispositions(JSON.stringify([{ line: 'C1', action: 'blocks', ref: '' }]));
    expect(gate(report, { dispositions: blocks, reviewerFile: () => true })).toEqual([
      'C1 (FAIL) has no re-check or default-branch proof the reviewer wrote',
    ]);
  });

  it('a shipping pipeline whose review step failed never merges (the #362 case)', () => {
    const log = [
      JSON.stringify({ step: 'ship__deliver__review__code', type: 'node_complete' }),
      JSON.stringify({
        step: 'ship__deliver__review__synthesize',
        type: 'node_error',
        error: 'the artifact pointer at $.report refers to a file that does not exist',
      }),
      JSON.stringify({ step: 'check-app', type: 'node_error', error: 'not a ship node' }),
    ].join('\n');
    const failures = shipFailuresInLog(log);
    expect(failures).toEqual([
      'ship__deliver__review__synthesize: the artifact pointer at $.report refers to a file that does not exist',
    ]);
    expect(gate(CLEAN, { shipFailures: failures })).toEqual([
      "the shipping pipeline's ship__deliver__review__synthesize: the artifact pointer at $.report refers to a file that does not exist failed",
    ]);
  });

  it('a question does not fail the check, but the review must decide it', () => {
    const report = CLEAN.replace(
      'DEFECTS SEEN: none',
      'DEFECTS SEEN\nD1 QUESTION  a refused save drops what was typed into the edit form  [evidence: d1.txt]'
    );
    expect(evidenceProblems(parseAppCheck(report), STARTED, () => fresh)).toEqual([]);
    expect(gate(report)).toEqual([
      'D1 is an open question the review did not decide (an issue, or accepted with a reason)',
    ]);
    const thin = parseDispositions(JSON.stringify([{ line: 'D1', action: 'accepted', ref: 'fine' }]));
    expect(gate(report, { dispositions: thin })).toHaveLength(1);
    const reasoned = parseDispositions(
      JSON.stringify([{ line: 'D1', action: 'accepted', ref: 'a locked note cannot be saved, so nothing savable is lost' }])
    );
    expect(gate(report, { dispositions: reasoned })).toEqual([]);
    const filed = parseDispositions(JSON.stringify([{ line: 'D1', action: 'issue', ref: '#60' }]));
    expect(gate(report, { dispositions: filed, issueExists: ref => ref === '#60' })).toEqual([]);
  });

  it('a disposition that quotes the whole report line is matched by its id (seen live)', () => {
    const quoted = parseDispositions(
      JSON.stringify([{ line: 'D1 NEW Export leaves out a note’s locked state', action: 'blocks', ref: 'x.txt' }])
    );
    expect([...quoted.keys()]).toEqual(['D1']);
    expect(parseDispositions(JSON.stringify([{ line: 'D12 NEW x', action: 'issue', ref: '#1' }])).has('D12')).toBe(true);
  });

  it('a line the evidence check flagged is cleared only by the reviewer’s own re-check', () => {
    const problems = 'C1 cites town.png, which does not exist\nH1 cites h1.txt, which does not exist';
    const rechecked = parseDispositions(
      JSON.stringify([
        { line: 'C1', action: 'rechecked', ref: 'recheck.md' },
        { line: 'H1', action: 'rechecked', ref: 'recheck.md' },
      ])
    );
    const base = { evidenceOk: false, evidenceProblems: problems, dispositions: rechecked };
    expect(gate(CLEAN, { ...base, reviewerFile: () => true })).toEqual([]);
    expect(gate(CLEAN, { ...base, reviewerFile: () => false })).toHaveLength(1);
    const half = parseDispositions(JSON.stringify([{ line: 'C1', action: 'rechecked', ref: 'recheck.md' }]));
    expect(gate(CLEAN, { ...base, dispositions: half, reviewerFile: () => true })).toEqual([
      "the app check's report did not hold up: H1 cites h1.txt, which does not exist",
    ]);
    // A problem with the report as a whole has no re-check that clears it.
    expect(
      gate(CLEAN, { ...base, evidenceProblems: 'Overall says PASS over D1', reviewerFile: () => true })
    ).toHaveLength(1);
  });

  it('malformed dispositions are ignored, never trusted', () => {
    expect(parseDispositions('not json').size).toBe(0);
    expect(parseDispositions('{"line":"D1"}').size).toBe(0);
    expect(parseDispositions('[null, {"line": 3}, {"line":"h1","action":"issue","ref":"#2"}]').get('H1')).toEqual({
      line: 'H1',
      action: 'issue',
      ref: '#2',
    });
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
    const prompt = readFileSync(resolve(pack, 'loop/commands/loop-check-app.md'), 'utf8');
    expect(prompt).not.toContain('$INPUTS.builder');
    expect(prompt).not.toContain('$INPUTS.ship');
    expect(prompt).toContain('DEFECTS SEEN');
    expect(prompt).toContain('PROBES');
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
});
