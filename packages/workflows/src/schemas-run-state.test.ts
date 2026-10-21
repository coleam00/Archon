// @archon-test-isolated
import { describe, test, expect } from 'bun:test';
import {
  approvalContextSchema,
  isApprovalContext,
  isWorkflowWaitContext,
  readWorkflowWaitContext,
  pausedAttentionWait,
  pausedUsageLimitWait,
  pendingWorkflowWaitDeadline,
  bodySessionCursorsSchema,
  bodySessionCursorAncestrySchema,
} from './schemas/workflow-run';
import {
  readSubrunMetadata,
  RUN_METADATA_KEYS,
  readIdentityUnresolved,
  workflowWaitContextSchema,
  scheduledWorkflowResumeSchema,
  workflowWaitStepName,
  nodeOutputSchema,
  runAttention,
} from './schemas';
import type { WorkflowWaitContext } from './schemas';

describe('nodeOutputSchema', () => {
  test('requires provenance on skipped outputs while pending remains cause-free', () => {
    expect(nodeOutputSchema.safeParse({ state: 'skipped', output: '' }).success).toBe(false);
    expect(nodeOutputSchema.safeParse({ state: 'pending', output: '' }).success).toBe(true);

    for (const cause of [
      { kind: 'condition', expr: '$route.output == true' },
      { kind: 'condition_parse_error', expr: '$route.output =' },
      { kind: 'upstream_failed', origin: 'validate' },
      { kind: 'upstream_skipped', origin: 'optional-review' },
      { kind: 'timeout' },
    ]) {
      expect(nodeOutputSchema.safeParse({ state: 'skipped', output: '', cause }).success).toBe(
        true
      );
    }
  });
});

describe('authored approval context', () => {
  const base = { nodeId: 'review', message: 'Choose' };
  test.each([
    { decisions: undefined },
    { decisions: [] },
    { decisions: [{ label: 'Missing id' }] },
  ])('refuses authored contexts without usable decisions (%j)', ({ decisions }) => {
    const approval = { ...base, decisionsAuthored: true, decisions };
    expect(approvalContextSchema.safeParse(approval).success).toBe(false);
    expect(isApprovalContext(approval)).toBe(false);
  });
  test('round trips authored decisions and legacy contexts', () => {
    for (const approval of [
      base,
      { ...base, decisionsAuthored: false as const },
      {
        ...base,
        decisionsAuthored: true as const,
        decisions: [{ id: 'accept', label: 'Accept plan' }, { id: 'revise' }],
      },
    ]) {
      expect(approvalContextSchema.parse(approval)).toEqual(approval);
      expect(isApprovalContext(approval)).toBe(true);
    }
  });
});

describe('persisted workflow continuation schemas', () => {
  const timeWait = {
    owner: 'node' as const,
    nodeId: 'later',
    kind: 'time' as const,
    waitingSince: '2026-08-24T10:00:00.000Z',
    resumeAt: '2026-08-25T10:00:00.000Z',
  };

  const owners = [
    { owner: 'node', nodeId: 'later' },
    {
      owner: 'loop_group',
      nodeId: 'group',
      bodyWaitId: 'later',
      iteration: 2,
      sessionId: null,
      sessionProvider: null,
    },
  ];
  const conditions = [
    { kind: 'time', resumeAt: timeWait.resumeAt },
    { kind: 'event', resumeAt: timeWait.resumeAt, event: 'ready' },
    { kind: 'attention', message: 'Fix CI' },
    { kind: 'quota', resumeAt: timeWait.resumeAt, pauseId: 'quota-1' },
  ];
  const waitCases = owners.flatMap(owner =>
    conditions
      .filter(condition => owner.owner !== 'loop_group' || condition.kind !== 'quota')
      .map(condition => ({ ...owner, ...condition, waitingSince: timeWait.waitingSince }))
  );
  test.each(waitCases)('recognizes future wait keys (%j)', value => {
    const wait = workflowWaitContextSchema.parse(value);
    for (const occurrence of [{}, { pauseId: 'pause-1' }]) {
      const known = { ...wait, ...occurrence };
      const future = { ...known, futureField: true };
      expect(isWorkflowWaitContext(future)).toBe(true);
      expect(readWorkflowWaitContext(future)).toEqual(known);
      expect(future).toEqual({ ...known, futureField: true });
      expect(workflowWaitContextSchema.safeParse(future).success).toBe(false);
      const run = { status: 'paused' as const, metadata: { wait: future } };
      if (known.kind === 'attention') {
        expect(pausedAttentionWait(run)).toEqual(known);
        expect(runAttention({ id: 'future', ...run })).toMatchObject({ kind: 'attention' });
      } else if (known.kind === 'quota') {
        expect(pausedUsageLimitWait(run)).toEqual(known);
      }
      expect(pendingWorkflowWaitDeadline(run)).toEqual(
        known.kind === 'attention' ? undefined : known
      );
    }
  });

  test('retains modern attention values while ignoring future top-level fields', () => {
    const known = {
      owner: 'node',
      nodeId: 'ask',
      kind: 'attention',
      waitingSince: timeWait.waitingSince,
      message: 'Fix CI',
      pauseId: 'ask-2',
      form: 'select',
      options: [{ id: 'retry', label: 'Retry' }],
      answer: { decision: 'retry', text: 'done' },
      answeredVia: 'cli',
      answeredAt: timeWait.waitingSince,
      labels: { ci: 'pr' },
      revision: 3,
      reaskedFrom: 'ask-1',
    } satisfies WorkflowWaitContext;
    expect(readWorkflowWaitContext({ ...known, futureField: true })).toEqual(known);
  });

  test('validates known fields and discriminators when reading future waits', () => {
    for (const invalid of [
      null,
      [],
      'wait',
      42,
      { ...timeWait, kind: 'future' },
      { ...timeWait, owner: 'future' },
      { ...timeWait, nodeId: undefined },
      { ...timeWait, waitingSince: 42 },
      { ...timeWait, resumeAt: 'tomorrow' },
      { ...timeWait, kind: 'event' },
      { ...timeWait, owner: 'loop_group' },
      { ...timeWait, event: 'ready' },
      { ...timeWait, bodyWaitId: 'body' },
      { ...timeWait, kind: 'attention', message: 'Fix CI' },
      {
        owner: 'node',
        nodeId: 'ask',
        kind: 'attention',
        waitingSince: timeWait.waitingSince,
        message: 'Fix CI',
        answer: { text: 'done', futureAnswerField: true },
      },
      {
        owner: 'node',
        nodeId: 'ask',
        kind: 'attention',
        waitingSince: timeWait.waitingSince,
        message: 'Fix CI',
        options: [{ id: 'retry', futureOptionField: true }],
      },
    ]) {
      expect(readWorkflowWaitContext(invalid)).toBeUndefined();
      if (invalid && typeof invalid === 'object') {
        expect(readWorkflowWaitContext({ ...invalid, futureField: true })).toBeUndefined();
      }
    }
  });

  test('round trips named owner cursors in approvals and every loop wait kind', () => {
    const bodySessionCursors = { owner: { sessionId: 'O', provider: 'pi' } };
    for (const cursors of [undefined, {}, bodySessionCursors]) {
      const approval = {
        nodeId: 'group',
        message: 'Review',
        ...(cursors
          ? { bodySessionCursors: cursors, bodySessionCursorAncestry: { '["group",[]]': cursors } }
          : {}),
      };
      expect(approvalContextSchema.parse(JSON.parse(JSON.stringify(approval)))).toEqual(approval);
      for (const condition of [
        { kind: 'time' as const, resumeAt: timeWait.resumeAt },
        { kind: 'event' as const, event: 'checks.complete', resumeAt: timeWait.resumeAt },
        {
          kind: 'attention' as const,
          message: 'Fix checks',
          loopQuestionReferences: {
            '$LOOP_PREV.work.output': '$other.output',
            $LOOP_USER_INPUT: 'feedback',
          },
        },
      ]) {
        const wait = {
          owner: 'loop_group' as const,
          nodeId: 'group',
          bodyWaitId: 'checks',
          iteration: 1,
          sessionId: null,
          sessionProvider: null,
          waitingSince: timeWait.waitingSince,
          ...condition,
          ...(cursors
            ? {
                bodySessionCursors: cursors,
                bodySessionCursorAncestry: { '["group",[]]': cursors },
              }
            : {}),
        };
        expect(workflowWaitContextSchema.parse(JSON.parse(JSON.stringify(wait)))).toEqual(wait);
      }
    }
    for (const cursor of [
      { sessionId: '', provider: 'pi' },
      { sessionId: 'O' },
      { sessionId: 'O', provider: '' },
    ]) {
      expect(bodySessionCursorsSchema.safeParse({ owner: cursor }).success).toBe(false);
      expect(
        bodySessionCursorAncestrySchema.safeParse({ '["group",[]]': { owner: cursor } }).success
      ).toBe(false);
    }
  });

  test('requires the fields belonging to the persisted wait kind and owner', () => {
    expect(workflowWaitContextSchema.safeParse(timeWait).success).toBe(true);
    expect(
      workflowWaitContextSchema.safeParse({ ...timeWait, event: 'deploy.complete' }).success
    ).toBe(false);
    expect(workflowWaitContextSchema.safeParse({ ...timeWait, kind: 'event' }).success).toBe(false);

    const loopEvent = workflowWaitContextSchema.parse({
      owner: 'loop_group',
      nodeId: 'release',
      bodyWaitId: 'checks',
      iteration: 2,
      sessionId: null,
      sessionProvider: null,
      kind: 'event',
      event: 'checks.complete',
      waitingSince: '2026-08-24T10:00:00.000Z',
      resumeAt: '2026-08-25T10:00:00.000Z',
    });
    expect(workflowWaitStepName(loopEvent)).toBe('release.checks');

    const attention = workflowWaitContextSchema.parse({
      owner: 'node',
      nodeId: 'recover-ci',
      kind: 'attention',
      waitingSince: '2026-08-24T10:00:00.000Z',
      message: 'Rerun CI, then resume.',
    });
    expect(workflowWaitStepName(attention)).toBe('recover-ci');
    expect(
      workflowWaitContextSchema.safeParse({ ...attention, resumeAt: timeWait.resumeAt }).success
    ).toBe(false);

    const loopAttention = workflowWaitContextSchema.parse({
      owner: 'loop_group',
      nodeId: 'recover',
      bodyWaitId: 'operator',
      iteration: 2,
      sessionId: null,
      sessionProvider: null,
      kind: 'attention',
      waitingSince: '2026-08-24T10:00:00.000Z',
      message: 'Fix the external failure, then resume.',
    });
    expect(workflowWaitStepName(loopAttention)).toBe('recover.operator');
  });

  test('rejects quota continuations beyond their attempt or time budget', () => {
    const scheduled = {
      reason: 'quota' as const,
      resumeAt: '2026-08-25T10:00:00.000Z',
      deadlineAt: '2026-08-26T10:00:00.000Z',
      attempt: 1,
      maxAttempts: 2,
    };
    expect(scheduledWorkflowResumeSchema.safeParse(scheduled).success).toBe(true);
    expect(scheduledWorkflowResumeSchema.safeParse({ ...scheduled, attempt: 3 }).success).toBe(
      false
    );
    expect(
      scheduledWorkflowResumeSchema.safeParse({
        ...scheduled,
        resumeAt: '2026-08-27T10:00:00.000Z',
      }).success
    ).toBe(false);
  });
});

describe('readSubrunMetadata — inputs (#2470)', () => {
  test('reads a well-formed inputs map', () => {
    const md = readSubrunMetadata({ inputs: { plan: 'do it', mode: 'fast' } });
    expect(md.inputs).toEqual({ plan: 'do it', mode: 'fast' });
  });

  test('treats a non-string-valued or non-object inputs as unset', () => {
    expect(readSubrunMetadata({ inputs: { plan: 5 } }).inputs).toBeUndefined();
    expect(readSubrunMetadata({ inputs: ['a'] }).inputs).toBeUndefined();
    expect(readSubrunMetadata({}).inputs).toBeUndefined();
    expect(readSubrunMetadata(undefined).inputs).toBeUndefined();
  });
});

describe('readIdentityUnresolved (#2304)', () => {
  test('reads a true stamp', () => {
    expect(readIdentityUnresolved({ [RUN_METADATA_KEYS.identityUnresolved]: true })).toBe(true);
  });

  test('reads a false stamp', () => {
    expect(readIdentityUnresolved({ [RUN_METADATA_KEYS.identityUnresolved]: false })).toBe(false);
  });

  test('treats a missing key as undefined', () => {
    expect(readIdentityUnresolved({})).toBeUndefined();
    expect(readIdentityUnresolved(undefined)).toBeUndefined();
  });

  test('treats a non-boolean value as undefined (defensive)', () => {
    expect(
      readIdentityUnresolved({ [RUN_METADATA_KEYS.identityUnresolved]: 'yes' })
    ).toBeUndefined();
    expect(readIdentityUnresolved({ [RUN_METADATA_KEYS.identityUnresolved]: 1 })).toBeUndefined();
    expect(
      readIdentityUnresolved({ [RUN_METADATA_KEYS.identityUnresolved]: null })
    ).toBeUndefined();
    expect(readIdentityUnresolved({ [RUN_METADATA_KEYS.identityUnresolved]: {} })).toBeUndefined();
  });
});
