/**
 * polish-scope decides whether a converged delivery spends one more implementation
 * pass. It reads the review's findings record for an open note, and the delta
 * structure pass's flag; either one is enough.
 */
import { describe, expect, it } from 'bun:test';
import { runPackScript, type ScriptRun } from './deliver-checks-harness';

function scope(findings: unknown[] | undefined, deltaFindings: 'true' | 'false'): ScriptRun {
  return runPackScript('deliver/scripts/polish-scope', {
    inputs: { INPUTS_DELTA_FINDINGS: deltaFindings },
    ...(findings === undefined
      ? {}
      : { artifacts: { 'review/findings.json': JSON.stringify(findings) } }),
  });
}

function finding(severity: string, status: string): Record<string, unknown> {
  return { id: 'R1', severity, sources: ['code'], claim: 'c', status, round: 1 };
}

describe('polish-scope', () => {
  it('polishes an open note', () => {
    const run = scope([finding('note', 'open')], 'false');
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ polish: true });
  });

  it('leaves a fixed note and a blocking finding alone', () => {
    // A ready verdict carries no open blocking finding; one here is not polish's work.
    const run = scope([finding('note', 'fixed'), finding('blocking', 'open')], 'false');
    expect(JSON.parse(run.stdout)).toEqual({ polish: false });
  });

  it('polishes when only the delta structure pass reported findings', () => {
    const run = scope([], 'true');
    expect(JSON.parse(run.stdout)).toEqual({ polish: true });
  });

  it('counts an unreadable findings record as no open note, and says so', () => {
    const run = scope(undefined, 'false');
    expect(JSON.parse(run.stdout)).toEqual({ polish: false });
    expect(run.stderr).toContain('no readable review/findings.json');
  });
});
