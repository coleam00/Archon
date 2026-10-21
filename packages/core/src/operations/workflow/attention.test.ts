import { describe, expect, mock, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureLogLines, trackTempRoots } from '@archon/paths/test-utils';
import { createFileWorkflowStore } from '@archon/workflows/file-store';
import type { IWorkflowStore } from '@archon/workflows/store';
import { ATTENTION_OUTPUT_FORMATS } from '@archon/workflows/schemas/dag-node';
import {
  attentionAnswerSchema,
  type WorkflowAttentionWaitContext,
} from '@archon/workflows/schemas/workflow-run';
import { validateStructuredOutput } from '@archon/workflows/structured-output';
import { RunActionForbiddenError } from '../run-authorization';
import {
  ResumeRefusedError,
  StaleGateAnswerError,
  createWorkflowOperations,
  expectedGateForOccurrence,
  type WorkflowOperations,
} from '../workflow-operations';

const roots = trackTempRoots();
const operator = { kind: 'operator' } as const;
const cli = { via: 'cli' } as const;
let store: IWorkflowStore;
let operations: WorkflowOperations;

async function setup(
  overrides: Partial<Pick<IWorkflowStore, 'getWorkflowRun' | 'labelAttentionWait'>> = {}
): Promise<void> {
  store = await createFileWorkflowStore({
    root: roots(await mkdtemp(join(tmpdir(), 'attention-answer-'))),
  });
  operations = createWorkflowOperations({
    getUserRole: async () => undefined,
    store: {
      ...store,
      ...overrides,
      deleteWorkflowRun: async () => {
        throw new Error('unused');
      },
    },
    hostStore: {
      isolation: {
        getById: async () => null,
        findActiveByWorkflow: async () => null,
        listActive: async () => [],
        create: async () => {
          throw new Error('unused');
        },
        updateStatus: async () => {},
        withWorktreeRegistration: async () => {
          throw new Error('Unexpected worktree removal');
        },
        markWorktreeDestroyed: async () => {},
        updateMetadata: async () => undefined,
        countActiveByCodebase: async () => 0,
      },
    },
    requestDetachedRunStop: async () => {
      throw new Error('unused');
    },
    isRunOwnedByThisProcess: () => false,
    isRunOwnerAnswering: async () => false,
    reclaimContainerEnv: async () => {},
    reclaimRunWorktree: async () => ({ warnings: [] }),
  });
}

/** A run paused at an attention wait of `form`, with options `a` and `b` where it takes options. */
async function paused(
  form: NonNullable<WorkflowAttentionWaitContext['form']> | undefined,
  pauseId: string | null = 'pause-1'
): Promise<string> {
  const run = await store.createWorkflowRun({ workflow_name: 'ask', user_message: '' });
  await store.claimPendingWorkflowRun(run.id);
  await store.pauseWorkflowRunForWait(
    run.id,
    {
      owner: 'node',
      nodeId: 'ask',
      kind: 'attention',
      waitingSince: '2026-10-14T00:00:00.000Z',
      message: 'Decide',
      ...(pauseId !== null ? { pauseId } : {}),
      ...(form !== undefined ? { form } : {}),
      ...(form === 'select' || form === 'multi_select'
        ? { options: [{ id: 'a' }, { id: 'b' }] }
        : {}),
    },
    { kind: 'started', stepName: 'ask' }
  );
  return run.id;
}

async function storedWait(id: string): Promise<Record<string, unknown>> {
  return (await store.getWorkflowRun(id))?.metadata.wait as Record<string, unknown>;
}

describe('answering an attention wait', () => {
  const cases = [
    { form: 'message', valid: { choose: [], text: 'done' }, output: { text: 'done' } },
    {
      form: 'approval',
      valid: { choose: ['reject'], text: 'no' },
      output: { decision: 'reject', text: 'no' },
    },
    { form: 'select', valid: { choose: ['b'] }, output: { decision: 'b', text: '' } },
    {
      form: 'multi_select',
      valid: { choose: ['a', 'b'] },
      output: { decisions: ['a', 'b'], text: '' },
    },
  ] as const;
  for (const { form, valid, output } of cases) {
    test(`a ${form} answer records its output shape, surface and time, and is due`, async () => {
      await setup();
      const id = await paused(form);
      const result = await operations.answerWorkflow(id, valid, operator, cli);
      expect(result.answer).toEqual(output);
      // The answer the operation builds is what the form's output contract declares,
      // and what the persisted wait accepts.
      expect(validateStructuredOutput(result.answer, ATTENTION_OUTPUT_FORMATS[form])).toEqual({
        valid: true,
      });
      expect(attentionAnswerSchema.safeParse(result.answer).success).toBe(true);
      expect(await storedWait(id)).toMatchObject({
        answer: output,
        answeredVia: 'cli',
        answeredAt: expect.any(String),
      });
      expect((await store.getWorkflowRun(id))?.status).toBe('paused');
      expect(
        (await store.listDueWorkflowContinuations(new Date(), 10)).map(run => run.id)
      ).toContain(id);
    });
  }

  const refusals = [
    ['message', { choose: ['a'] }, 'takes only text'],
    ['approval', { choose: ['maybe'] }, "does not declare option 'maybe'"],
    ['approval', { choose: [] }, 'takes exactly one option'],
    ['select', { choose: ['c'] }, "does not declare option 'c'"],
    ['select', { choose: ['a', 'b'] }, 'takes exactly one option'],
    ['multi_select', { choose: [] }, 'needs at least one option'],
    ['multi_select', { choose: ['a', 'a'] }, 'takes each option at most once'],
  ] as const;
  for (const [form, request, problem] of refusals) {
    test(`a ${form} wait refuses ${JSON.stringify(request.choose)}`, async () => {
      await setup();
      const id = await paused(form);
      await expect(operations.answerWorkflow(id, request, operator, cli)).rejects.toThrow(problem);
      expect(await storedWait(id)).not.toHaveProperty('answer');
    });
  }

  test('a stale occurrence is refused before the answer is judged', async () => {
    await setup();
    const id = await paused('select');
    const run = await store.getWorkflowRun(id);
    if (!run) throw new Error('missing run');
    const stale = { via: 'cli' as const, expectedGate: expectedGateForOccurrence(run, 'old') };
    const refusal = operations.answerWorkflow(id, { choose: ['undeclared'] }, operator, stale);
    await expect(refusal).rejects.toBeInstanceOf(StaleGateAnswerError);
    await expect(refusal).rejects.toThrow("It is now awaiting occurrence 'pause-1'");
    const current = {
      via: 'cli' as const,
      expectedGate: expectedGateForOccurrence(run, 'pause-1'),
    };
    await operations.answerWorkflow(id, { choose: ['a'] }, operator, current);
    await expect(operations.answerWorkflow(id, { choose: ['b'] }, operator, cli)).rejects.toThrow(
      'already answered'
    );
  });

  test('approve, reject and respond answer an attention wait as sugar; reject never cancels', async () => {
    await setup();
    const message = await paused('message');
    await operations.approveWorkflow(message, 'all set', operator, cli);
    expect(await storedWait(message)).toMatchObject({ answer: { text: 'all set' } });

    const approval = await paused('approval');
    const rejected = await operations.rejectWorkflow(approval, 'not yet', operator, cli);
    expect(rejected.cancelled).toBe(false);
    expect((await store.getWorkflowRun(approval))?.status).toBe('paused');
    expect(await storedWait(approval)).toMatchObject({
      answer: { decision: 'reject', text: 'not yet' },
    });

    const select = await paused('select');
    await operations.respondToWorkflow(select, 'b', undefined, operator, cli);
    expect(await storedWait(select)).toMatchObject({ answer: { decision: 'b', text: '' } });
    await expect(
      operations.respondToWorkflow(await paused('select'), 'c', undefined, operator, cli)
    ).rejects.toThrow("does not declare option 'c'");
  });

  test('whitespace-only approve and reject text answers an attention wait with no text', async () => {
    await setup();
    const rejected = await paused('approval');
    await operations.rejectWorkflow(rejected, '   ', operator, cli);
    expect(await storedWait(rejected)).toMatchObject({
      answer: { decision: 'reject', text: '' },
    });

    const approved = await paused('approval');
    await operations.approveWorkflow(approved, '   ', operator, cli);
    expect(await storedWait(approved)).toMatchObject({
      answer: { decision: 'approve', text: '' },
    });
  });

  test('a wait from before answers resumes; an unanswered form wait refuses resume', async () => {
    await setup();
    const legacy = await paused(undefined, null);
    await expect(operations.answerWorkflow(legacy, { choose: [] }, operator, cli)).rejects.toThrow(
      'Continue it with resume'
    );
    expect((await operations.resumeWorkflow(legacy, operator)).id).toBe(legacy);
    const refusal = operations.resumeWorkflow(await paused('select'), operator);
    await expect(refusal).rejects.toBeInstanceOf(ResumeRefusedError);
    await expect(refusal).rejects.toThrow("waiting for an answer to its 'select' attention wait");
  });
});

describe('labeling an attention wait', () => {
  test('merges set and unset keys and reports the new revision', async () => {
    await setup();
    const id = await paused('message');
    const first = await operations.labelAttentionWait(
      id,
      { occurrence: 'pause-1', set: { ci: 'other', urgency: 'high' }, unset: [] },
      operator,
      'cli'
    );
    expect(first).toEqual({
      runId: id,
      occurrence: 'pause-1',
      revision: 2,
      labels: { ci: 'other', urgency: 'high' },
    });
    const second = await operations.labelAttentionWait(
      id,
      { occurrence: 'pause-1', set: { ci: 'pr' }, unset: ['urgency'] },
      operator,
      'api'
    );
    expect(second).toMatchObject({ revision: 3, labels: { ci: 'pr' } });
  });

  test('refuses a stale occurrence by naming the current one, and writes nothing', async () => {
    await setup();
    const id = await paused('message');
    const write = { occurrence: 'pause-0', set: { ci: 'other' }, unset: [] };
    const refusal = operations.labelAttentionWait(id, write, operator, 'cli');
    await expect(refusal).rejects.toBeInstanceOf(StaleGateAnswerError);
    await expect(operations.labelAttentionWait(id, write, operator, 'cli')).rejects.toThrow(
      "awaiting occurrence 'pause-1'"
    );
    expect(await storedWait(id)).not.toHaveProperty('labels');
  });

  test('a lost label race stays a stale answer when the run cannot be re-read', async () => {
    const lookupError = new Error('connection reset');
    const getWorkflowRun = mock<IWorkflowStore['getWorkflowRun']>(id => store.getWorkflowRun(id));
    const labelAttentionWait = mock<IWorkflowStore['labelAttentionWait']>(async () => {
      getWorkflowRun.mockRejectedValueOnce(lookupError);
      return { labeled: false };
    });
    await setup({ getWorkflowRun, labelAttentionWait });
    const id = await paused('message');

    const logs = captureLogLines();
    try {
      await expect(
        operations.labelAttentionWait(
          id,
          { occurrence: 'pause-1', set: { ci: 'other' }, unset: [] },
          operator,
          'cli'
        )
      ).rejects.toBeInstanceOf(StaleGateAnswerError);
      expect(logs.lines).toContainEqual(
        expect.objectContaining({
          level: 40,
          msg: 'operations.workflow_gate_occurrence_lookup_failed',
          runId: id,
          err: expect.objectContaining({
            type: 'Error',
            message: lookupError.message,
            stack: lookupError.stack,
          }),
        })
      );
    } finally {
      logs.restore();
    }
    expect(labelAttentionWait).toHaveBeenCalledWith(id, {
      pauseId: 'pause-1',
      set: { ci: 'other' },
      unset: [],
      via: 'cli',
    });
    expect(getWorkflowRun).toHaveBeenCalledTimes(2);
    expect(await storedWait(id)).not.toHaveProperty('labels');
  });

  test('refuses a malformed write, a gate, an answered wait and an unauthorized actor', async () => {
    await setup();
    const id = await paused('message');
    const label = (
      runId: string,
      request: { occurrence: string; set: Record<string, string>; unset: string[] },
      actor: Parameters<WorkflowOperations['labelAttentionWait']>[2] = operator
    ): Promise<unknown> => operations.labelAttentionWait(runId, request, actor, 'cli');
    await expect(label(id, { occurrence: 'pause-1', set: {}, unset: [] })).rejects.toThrow(
      'at least one key'
    );
    await expect(
      label(id, { occurrence: 'pause-1', set: { ci: 'x' }, unset: ['ci'] })
    ).rejects.toThrow("Label 'ci' is both set and unset");
    await expect(
      label(id, { occurrence: 'pause-1', set: {}, unset: ['bad key'] })
    ).rejects.toThrow();

    const gate = await store.createWorkflowRun({ workflow_name: 'gate', user_message: '' });
    await store.claimPendingWorkflowRun(gate.id);
    await store.pauseWorkflowRun(gate.id, {
      nodeId: 'review',
      message: 'Ship?',
      type: 'approval',
      pauseId: 'gate-1',
    });
    await expect(
      label(gate.id, { occurrence: 'gate-1', set: { ci: 'x' }, unset: [] })
    ).rejects.toThrow('Only attention waits carry labels');

    await operations.answerWorkflow(id, { choose: [], text: 'done' }, operator, cli);
    await expect(label(id, { occurrence: 'pause-1', set: { ci: 'x' }, unset: [] })).rejects.toThrow(
      'It is not awaiting an answer now'
    );

    const owned = await store.createWorkflowRun({ workflow_name: 'ask', user_message: '' });
    await expect(
      label(
        owned.id,
        { occurrence: 'pause-1', set: { ci: 'x' }, unset: [] },
        { kind: 'user', userId: 'someone-else' }
      )
    ).rejects.toBeInstanceOf(RunActionForbiddenError);
  });
});
