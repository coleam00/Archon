/**
 * The god-mode pack's deterministic core: the trust ladder that decides how much a run
 * may do unasked, the per-attempt verdict that decides whether a mission succeeded,
 * the tally that feeds the ladder, and the forge's draft judge. The routing around
 * them is proved by the dry-run fixtures beside each workflow.
 */
import { describe, expect, it } from 'bun:test';
import { type Charter, plan, proceed, standingCharter, tally } from '../../workflows/god-mode/.shared/conductor';
import { judgeDraft } from '../../workflows/god-mode/.shared/forge';
import { fresh, recall } from '../../workflows/god-mode/.shared/lessons';
import { type AttemptInput, decideAttempt, type Mission, parseMission } from '../../workflows/god-mode/.shared/mission';
import { assess, type MissionRecord, needsApproval } from '../../workflows/god-mode/.shared/trust';

function records(outcomes: boolean[]): { records: MissionRecord[] } {
  return { records: outcomes.map((succeeded, i) => ({ at: `t${i}`, run: `r${i}`, mission: `m${i}`, succeeded })) };
}

const MISSION: Mission = { id: 'one', objective: 'o', context: 'c', done_when: 'd', acceptance: ['true'] };

describe('trust ladder', () => {
  it('starts supervised with no history', () => {
    const t = assess(null);
    expect(t).toMatchObject({ level: 'supervised', gate_plan: true, max_missions: 3, window: 0 });
  });

  it('earns trusted at five missions and 80%', () => {
    expect(assess(records([true, true, false, true, true])).level).toBe('trusted');
    expect(assess(records([true, false, true, false, true])).level).toBe('supervised');
  });

  it('earns autonomous only with a long record and a clean recent streak', () => {
    const long = Array(15).fill(true) as boolean[];
    expect(assess(records(long))).toMatchObject({ level: 'autonomous', gate_plan: false, max_missions: 20 });
    // 90% overall, but a failure inside the last five holds it at trusted.
    expect(assess(records([...long, false, true, true, true])).level).toBe('trusted');
  });

  it('trips the circuit breaker on two failures in the last three', () => {
    const t = assess(records([...(Array(18).fill(true) as boolean[]), false, false]));
    expect(t.level).toBe('supervised');
    expect(t.reason).toContain('circuit breaker');
  });

  it('reads only the most recent window', () => {
    const old = Array(30).fill(false) as boolean[];
    expect(assess(records([...old, ...(Array(20).fill(true) as boolean[])])).level).toBe('autonomous');
  });

  it('gates a plan wider than the level allows even when autonomous', () => {
    const t = assess(records(Array(20).fill(true) as boolean[]));
    expect(needsApproval(t, 20)).toBe(false);
    expect(needsApproval(t, 21)).toBe(true);
  });
});

describe('mission contract', () => {
  it('accepts a complete mission', () => {
    expect(parseMission(JSON.stringify(MISSION))).toEqual(MISSION);
  });

  it('refuses a mission nothing can verify', () => {
    expect(() => parseMission({ ...MISSION, acceptance: [] })).toThrow('no acceptance commands');
    expect(() => parseMission({ ...MISSION, acceptance: ['  '] })).toThrow('empty or non-text');
  });

  it('refuses a non-kebab id', () => {
    expect(() => parseMission({ ...MISSION, id: 'Not Kebab' })).toThrow('kebab-case');
  });
});

describe('attempt verdict', () => {
  const base: AttemptInput = {
    previous: 0,
    blocked: false,
    blocker: '',
    summary: 's',
    pass: true,
    report: 'VERIFICATION: PASS',
    approve: true,
    findings: '',
  };

  it('succeeds only when the checks pass and the reviewer approves', () => {
    expect(decideAttempt(base)).toMatchObject({ done: true, succeeded: true, reason: 'accepted', attempt: 1 });
    expect(decideAttempt({ ...base, approve: false, findings: 'x' })).toMatchObject({ done: false, succeeded: false });
  });

  it('never lets an approving reviewer overrule failing checks', () => {
    const v = decideAttempt({ ...base, pass: false, report: 'exit 1' });
    expect(v).toMatchObject({ done: false, succeeded: false, reason: 'retry' });
    expect(v.feedback).toContain('FAILED');
  });

  it('ends as a typed failure on the last attempt', () => {
    expect(decideAttempt({ ...base, previous: 2, pass: false })).toMatchObject({
      done: true,
      succeeded: false,
      reason: 'attempts_exhausted',
      attempt: 3,
    });
  });

  it('ends at once on a block or a failed body node', () => {
    expect(decideAttempt({ ...base, blocked: true, blocker: 'needs a decision' })).toMatchObject({
      done: true,
      reason: 'blocked',
      feedback: 'needs a decision',
    });
    expect(decideAttempt({ ...base, pass: null })).toMatchObject({ done: true, reason: 'node_failed' });
  });
});

describe('conductor', () => {
  const charter: Charter = {
    complete: true,
    question: '',
    brief: { problem: 'p', why: 'w', why_now: 'n', outcome: 'o', invariants: [], acceptance: ['a'] },
    approach: 'a',
    missions: [MISSION],
  };

  it('prefers the rewritten charter and refuses one still incomplete', () => {
    const second = { ...charter, approach: 'second' };
    expect(standingCharter({ ...charter, complete: false }, second).approach).toBe('second');
    expect(() => standingCharter(charter, { ...charter, complete: false, question: 'q?' })).toThrow('still incomplete');
  });

  it('refuses duplicate mission ids and empty plans', () => {
    expect(() => standingCharter({ ...charter, missions: [MISSION, MISSION] }, null)).toThrow('share the id');
    expect(() => standingCharter({ ...charter, missions: [] }, null)).toThrow('no missions');
  });

  it('shows the person the whole plan and the trust behind the gate', () => {
    const p = plan(charter, assess(null));
    expect(p.gate).toBe(true);
    expect(p.message).toContain('one: o');
    expect(p.message).toContain('Trust: supervised');
  });

  it('proceeds only on approval or earned autonomy', () => {
    expect(proceed(false, null).go).toBe(true);
    expect(proceed(true, { decision: 'approve' }).go).toBe(true);
    expect(proceed(true, { decision: 'reject', text: 'too broad' })).toEqual({
      go: false,
      reason: 'the plan was rejected: too broad',
    });
    expect(proceed(true, null).go).toBe(false);
  });

  it('counts a crashed child as a failed mission, matched by position', () => {
    const two = { ...MISSION, id: 'two' };
    const t = tally(
      [MISSION, two],
      [
        { mission: 'one', succeeded: true, reason: 'accepted', attempts: 1, summary: 's', evidence: 'e', branch: 'b' },
        { archon_failed: true, error: 'boom', status: 'failed' },
      ],
    );
    expect(t).toMatchObject({ total: 2, succeeded: 1, failed: 1, all_succeeded: false });
    expect(t.outcomes).toEqual([
      { mission: 'one', succeeded: true },
      { mission: 'two', succeeded: false },
    ]);
    expect(t.report).toContain('two: FAILED (child run failed)');
  });

  it('refuses a result list that does not match the plan', () => {
    expect(() => tally([MISSION], [])).toThrow('expected 1 mission results');
  });
});

describe('memory', () => {
  it('adds only lessons not already remembered', () => {
    const existing = [{ at: 't', run: 'r', text: 'Run the build first.' }];
    expect(fresh(existing, ['run the  build first.', '', 'New lesson', 'new lesson'])).toEqual(['New lesson']);
  });

  it('recalls a readable list, or says the memory is empty', () => {
    expect(recall(null)).toContain('No lessons');
    expect(recall({ lessons: [{ at: 't', run: 'r', text: 'x' }] })).toBe('- x');
  });
});

describe('forge judge', () => {
  const valid = { results: [{ workflowName: 'w', valid: true, issues: [] }] };

  it('accepts a draft only when it validates and the dry run reaches an end', () => {
    expect(judgeDraft('w', 0, valid, '', { outcome: 'completed' }, '')).toMatchObject({ valid: true, done: true });
    expect(judgeDraft('w', 0, valid, '', { outcome: 'paused' }, '').valid).toBe(true);
    expect(judgeDraft('w', 0, valid, '', { outcome: 'failed' }, 'trace')).toMatchObject({ valid: false, done: false });
  });

  it('feeds the validator issues back, and stops after the last draft', () => {
    const rejected = {
      results: [{ workflowName: 'w', valid: false, issues: [{ level: 'error', message: 'unknown node zz' }] }],
    };
    const v = judgeDraft('w', 0, rejected, '', null, '');
    expect(v.report).toContain('unknown node zz');
    expect(judgeDraft('w', 2, rejected, '', null, '')).toMatchObject({ done: true, valid: false, attempt: 3 });
  });

  it('reports a draft the validator never found', () => {
    expect(judgeDraft('w', 0, { results: [] }, 'raw', null, '').report).toContain('no workflow named `w`');
  });
});
