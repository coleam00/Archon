import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { createFileWorkflowStore } from '@archon/workflows/file-store';
import type { IWorkflowStore } from '@archon/workflows/store';
import type { WorkflowAttentionWaitContext } from '@archon/workflows/schemas/workflow-run';
import {
  StaleGateAnswerError,
  createWorkflowOperations,
  expectedGateForOccurrence,
  type WorkflowOperations,
} from './workflow-operations';

const roots = trackTempRoots();
const operator = { kind: 'operator' } as const;
const cli = { via: 'cli' } as const;
let store: IWorkflowStore;
let operations: WorkflowOperations;

async function setup(): Promise<void> {
  store = await createFileWorkflowStore({
    root: roots(await mkdtemp(join(tmpdir(), 'attention-answer-'))),
  });
  operations = createWorkflowOperations({
    getUserRole: async () => undefined,
    store: {
      ...store,
      deleteWorkflowRun: async () => {
        throw new Error('unused');
      },
    },
    hostStore: {
      isolation: {
        getById: async () => null,
        findActiveByWorkflow: async () => null,
        create: async () => {
          throw new Error('unused');
        },
        updateStatus: async () => {},
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

  test('a wait from before answers resumes; an unanswered form wait refuses resume', async () => {
    await setup();
    const legacy = await paused(undefined, null);
    await expect(operations.answerWorkflow(legacy, { choose: [] }, operator, cli)).rejects.toThrow(
      'Continue it with resume'
    );
    expect((await operations.resumeWorkflow(legacy, operator)).id).toBe(legacy);
    await expect(operations.resumeWorkflow(await paused('select'), operator)).rejects.toThrow(
      "waiting for an answer to its 'select' attention wait"
    );
  });
});
