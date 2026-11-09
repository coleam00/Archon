/**
 * settle-review owns the review round's verdict: it demotes a blocking finding only
 * when two verifiers voted against it, and decides readiness again from the settled
 * findings and synthesis's coverage gaps.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packScriptRunner } from './deliver-checks-harness';

const { runPackScript } = packScriptRunner();

const REPORT = { type: 'archon_artifact', run_id: 'run', path: 'review/report.md' };

interface Finding { id: string; severity: string; sources: string[]; claim: string; status: string; round: number; action?: string }
const blocker = (id: string, sources: string[], action = 'correct'): Finding => ({ id, severity: 'blocking', sources, claim: `${id} is wrong`, status: 'open', round: 1, action });
const vote = (id: string, real: boolean, belongs: boolean) => ({ id, real, belongs, reason: `${id} at a.ts:1` });

function run(findings: unknown[], votes: Record<number, unknown[]>, gaps: string[], action: string) {
  const artifacts: Record<string, string> = {
    'review/findings.json': JSON.stringify(findings),
    'review/report.md': 'Not ready.\n',
    'review/report-round-1.md': 'Not ready.\n',
  };
  for (const [voter, list] of Object.entries(votes)) artifacts[`review/verify-${voter}.json`] = JSON.stringify(list);
  return runPackScript('review/scripts/settle-review', {
    inputs: {
      INPUTS_READY: 'false',
      INPUTS_ACTION: action,
      INPUTS_SUMMARY: 'Review report: report.md.',
      INPUTS_REPORT_POINTER: JSON.stringify(REPORT),
      INPUTS_DISCOVERIES: '[]',
      INPUTS_CONTRACT_LEFT: '[]',
      INPUTS_COVERAGE_GAPS: JSON.stringify(gaps),
    },
    artifacts,
  });
}

function settle(findings: Finding[], votes: Record<number, unknown[]>, gaps: string[] = [], action = 'correct') {
  const settled = run(findings, votes, gaps, action);
  expect(settled.code).toBe(0);
  const read = (name: string) => readFileSync(join(settled.artifacts, name), 'utf8');
  return { verdict: JSON.parse(settled.stdout), findings: JSON.parse(read('review/findings.json')) as Finding[], read };
}

describe('settle-review', () => {
  it('demotes blockers two verifiers reject, keeps a pre-existing one as a discovery, and turns Ready', () => {
    const { verdict, findings, read } = settle([blocker('R1', ['code']), blocker('R2', ['seams'])], {
      1: [vote('R1', false, true), vote('R2', true, false)],
      2: [vote('R1', false, false), vote('R2', true, false)],
      3: [vote('R1', true, true), vote('R2', true, true)],
    });
    expect(verdict).toMatchObject({ ready: true, action: 'none' });
    expect(findings.map(f => [f.id, f.severity, f.status])).toEqual([['R1', 'note', 'disproved'], ['R2', 'note', 'open']]);
    expect(verdict.discoveries).toEqual([
      expect.objectContaining({ title: 'R2 predates this change', relation: 'unrelated', source_nodes: ['seams', 'verify'] }),
    ]);
    expect(read('discoveries.md')).toContain('R2 predates this change');
    for (const name of ['review/report.md', 'review/report-round-1.md']) {
      expect(read(name)).toStartWith('> **Verification.**');
    }
  });

  it('upholds a blocker a missing verifier leaves at one vote against, and never demotes a contract finding', () => {
    const findings = [blocker('R1', ['code']), blocker('R2', ['code', 'contract'])];
    const settled = settle(findings, {
      1: [vote('R1', false, false), vote('R2', false, false)],
      2: [vote('R2', false, false)],
      3: [vote('R2', false, false)],
    });
    expect(settled.verdict).toMatchObject({ ready: false, action: 'correct' });
    expect(settled.findings).toEqual(findings);
    expect(settled.read('review/report.md')).toBe('Not ready.\n');
  });

  // The demoted blocker was the only reason to ask; the failed lens only needs the next round.
  it('stays not ready on a coverage gap when every blocker is demoted, without the demoted blocker\'s ask', () => {
    const { verdict, findings } = settle(
      [blocker('R1', ['code'], 'ask')],
      { 1: [vote('R1', false, true)], 2: [vote('R1', false, true)] },
      ['the tests lens failed'],
      'ask'
    );
    expect(findings[0]).toMatchObject({ severity: 'note', status: 'disproved' });
    expect(verdict).toMatchObject({ ready: false, action: 'correct' });
  });

  it('demotes a mixed rejection without a provenance claim, and takes the action the remaining blocker needs', () => {
    const { verdict, findings } = settle(
      [blocker('R1', ['seams'], 'ask'), blocker('R2', ['code'])],
      { 1: [vote('R1', false, true)], 2: [vote('R1', true, false)] },
      [],
      'ask'
    );
    expect(findings[0]).toMatchObject({ severity: 'note', status: 'open' });
    expect(verdict).toMatchObject({ ready: false, action: 'correct', discoveries: [] });
  });

  it('refuses findings it cannot settle soundly rather than settling around them', () => {
    const misspelled = run([blocker('R1', ['code']), { ...blocker('R2', ['code']), severity: 'Blocking' }], {}, [], 'correct');
    expect(misspelled.code).not.toBe(0);
    expect(misspelled.stderr).toContain('is not a list of findings');
    const { action: _, ...unacted } = blocker('R2', ['code']);
    const rejectAll = { 1: [vote('R1', false, true)], 2: [vote('R1', false, true)] };
    const noAction = run([blocker('R1', ['code']), unacted], rejectAll, [], 'ask');
    expect(noAction.code).not.toBe(0);
    expect(noAction.stderr).toContain('R2 carry no action');
  });
});
