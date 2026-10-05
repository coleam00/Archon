/**
 * file-discoveries files each certified discovery once: across runs through the
 * matching agent's judgment (stubbed here as its typed output), within a run through
 * the per-record marker. Runs against the fake gh, so no tracker is touched.
 */
import { describe, expect, it } from 'bun:test';
import { forgePrRecord, runPackScript, type GhIssue, type ScriptRun } from './deliver-checks-harness';

const ISSUES = 'https://ghe.example.com/example/repo/issues';

function discovery(title: string, claim: string): Record<string, unknown> {
  return {
    title,
    claim,
    evidence: ['packages/cli/src/forge-delivery.test.ts:40'],
    relation: 'unrelated',
    source_nodes: ['synthesize'],
  };
}

const forgeBug = (wording: string): Record<string, unknown> =>
  discovery(wording, 'The forge delivery test supplies a scratch trusted environment, but plugin discovery still reads the host Archon home.');

function file(
  records: readonly object[],
  matches: readonly { index: number; duplicate_of: string }[] = [],
  issues: readonly GhIssue[] = [],
  extra: { issueSearchFail?: string } = {}
): ScriptRun {
  return runPackScript('deliver/scripts/file-discoveries', {
    gh: { issues, ...extra },
    inputs: {
      INPUTS_PR: JSON.stringify(forgePrRecord()),
      INPUTS_INITIAL: JSON.stringify(records),
      INPUTS_FINAL: 'null',
      INPUTS_MATCHES: JSON.stringify(matches),
    },
  });
}

describe('file-discoveries across runs', () => {
  it('files a defect once when five runs word it differently and the matcher finds the first', () => {
    const tracker: GhIssue[] = [];
    const first = file([forgeBug('Forge delivery test reads the host Archon home')]);
    expect(first.code).toBe(0);
    expect(first.createdIssues).toHaveLength(1);
    tracker.push({ ...first.createdIssues[0] });
    const filed = `${ISSUES}/${String(tracker[0].number)}`;

    for (const wording of [
      'Plugin discovery escapes the scratch trusted environment',
      'forge-delivery test leaks host ~/.archon',
      'Scratch Archon home ignored by plugin discovery in tests',
      'Forge delivery fixture is not hermetic',
    ]) {
      const run = file([forgeBug(wording)], [{ index: 0, duplicate_of: filed }], tracker);
      expect(run.code).toBe(0);
      expect(run.createdIssues).toEqual([]);
      expect(JSON.parse(run.stdout)).toEqual({ records: [{ title: wording, issue: filed }] });
    }
  });

  it('files a different defect in the same file separately', () => {
    const existing: GhIssue = { number: 7, title: 'Forge test leaks home', body: 'x', state: 'OPEN' };
    const run = file(
      [forgeBug('Forge test leaks home'), discovery('Forge test asserts a stale argv', 'The argv assertion pins an old flag.')],
      [{ index: 0, duplicate_of: `${ISSUES}/7` }],
      [existing]
    );
    expect(run.code).toBe(0);
    expect(run.createdIssues.map(issue => issue.title)).toEqual(['Forge test asserts a stale argv']);
  });

  it('files a record as new when its match is not an open issue, and says so', () => {
    const closed: GhIssue = { number: 7, title: 'Old', body: 'x', state: 'CLOSED' };
    const run = file([forgeBug('Leak')], [{ index: 0, duplicate_of: `${ISSUES}/7` }], [closed]);
    expect(run.code).toBe(0);
    expect(run.createdIssues).toHaveLength(1);
    expect(run.stderr).toContain('is not an open issue');
  });
});

describe('file-discoveries within a run', () => {
  it('reuses the issue a resumed run already filed for the same record', () => {
    const first = file([forgeBug('Leak')]);
    const again = file([forgeBug('Leak')], [], [{ ...first.createdIssues[0] }]);
    expect(again.code).toBe(0);
    expect(again.createdIssues).toEqual([]);
  });

  it('carries the marker on the first line of every filed body', () => {
    const run = file([forgeBug('Leak')]);
    expect(run.createdIssues[0].body.split('\n')[0]).toMatch(/^<!-- archon-discovery:[0-9a-f]{64} -->$/);
  });

  it('refuses when the marker search fails, creating nothing', () => {
    const run = file([forgeBug('Leak')], [], [], { issueSearchFail: 'HTTP 502' });
    expect(run.code).not.toBe(0);
    expect(run.createdIssues).toEqual([]);
    expect(run.stderr).toContain('HTTP 502');
  });

  it('files the correction loop’s final records over the first review’s', () => {
    const run = runPackScript('deliver/scripts/file-discoveries', {
      inputs: {
        INPUTS_PR: JSON.stringify(forgePrRecord()),
        INPUTS_INITIAL: JSON.stringify([forgeBug('Early')]),
        INPUTS_FINAL: JSON.stringify([forgeBug('Final')]),
        INPUTS_MATCHES: '[]',
      },
    });
    expect(run.createdIssues.map(issue => issue.title)).toEqual(['Final']);
  });
});
