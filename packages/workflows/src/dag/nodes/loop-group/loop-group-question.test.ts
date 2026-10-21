// @archon-test-isolated
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { createEscalationStore, seedPreviousLoopGroupPass } from '../../pause-test-utils';
import {
  createMockDeps,
  dagOptions,
  ready,
  makeWorkflowRun,
  persistedEvents,
} from '../../test-utils';
import { foldDagResumeSnapshot } from '../../../dag-resume-snapshot';
import { executeDagWorkflow } from '../../../dag-executor';
import {
  workflowDefinitionSchema,
  workflowWaitContextSchema,
  type WorkflowWaitContext,
} from '../../../schemas';
import type { WorkflowEventRow } from '../../../schemas/workflow-event';
import { waitCompletionEvents, type PersistedNodeOutput } from '../../../store';

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'loop-question-'));
});
afterEach(async () => {
  await removeTempTree(cwd);
});

function readAttentionWait(value: unknown) {
  const wait = workflowWaitContextSchema.parse(value);
  if (wait.kind !== 'attention' || wait.owner !== 'loop_group')
    throw new Error('Expected loop attention wait');
  return wait;
}

function expectWaitInvocation(events: ReturnType<typeof persistedEvents>, nested: boolean) {
  for (const eventType of ['node_started', 'node_suspended']) {
    const event = events.find(
      event =>
        event.step_name === (nested ? 'outer.grp.ask' : 'grp.ask') && event.event_type === eventType
    );
    expect(event?.data).toHaveProperty('invocation.loopPath', [
      ...(nested ? [{ groupId: 'outer', iteration: 1 }] : []),
      { groupId: 'grp', iteration: 1 },
    ]);
  }
}

for (const change of ['none', 'message', 'options', 'form', 'body', 'nested'] as const) {
  test(`answered loop question: ${change}`, async () => {
    const source = join(cwd, 'question');
    const original = {
      message: 'Approve old release?',
      options: [{ id: 'approve', label: 'Old' }],
    };
    await Bun.write(source, JSON.stringify(original));
    const bodyProducer = change === 'body';
    const question = { id: 'question', bash: `cat '${source}'` };
    const group = {
      id: 'grp',
      ...(bodyProducer ? {} : { depends_on: ['question'] }),
      loop_group: {
        max_iterations: 2,
        until_bash: 'test $ask.output.decision = approve',
        nodes: [
          ...(bodyProducer ? [question] : []),
          {
            id: 'ask',
            ...(bodyProducer ? { depends_on: ['question'] } : {}),
            wait: {
              attention: '$question.output.message',
              form: 'select',
              options: '$question.output.options',
            },
          },
        ],
      },
    };
    const workflow = ready(
      workflowDefinitionSchema.parse({
        name: 'loop-question',
        description: 'Question integrity',
        nodes: [
          ...(bodyProducer ? [] : [{ ...question, always_run: true }]),
          ...(change === 'nested'
            ? [
                {
                  id: 'outer',
                  depends_on: ['question'],
                  loop_group: {
                    max_iterations: 2,
                    until_bash: 'true',
                    nodes: [{ ...group, depends_on: [] }],
                  },
                },
              ]
            : [group]),
          {
            id: 'after',
            depends_on: [change === 'nested' ? 'outer' : 'grp'],
            bash: 'printf downstream',
          },
        ],
      })
    );
    const first = createEscalationStore('question');
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(first),
        cwd,
        workflow,
        workflowRun: makeWorkflowRun('question'),
      })
    );
    const wait = readAttentionWait(first.getState().metadata.wait);
    expect(wait).toMatchObject({
      kind: 'attention',
      owner: 'loop_group',
      iteration: 1,
      message: original.message,
    });
    const current = {
      message:
        change === 'message' || change === 'nested' ? 'Approve NEW release?' : original.message,
      options: change === 'options' ? [{ id: 'approve', label: 'New' }] : original.options,
    };
    await Bun.write(source, JSON.stringify(current));
    const prior = new Map<string, PersistedNodeOutput>([
      [bodyProducer ? 'grp.question' : 'question', { output: JSON.stringify(original) }],
    ]);
    const answered: WorkflowWaitContext = {
      ...wait,
      answer: { decision: 'approve', text: '' },
      ...(change === 'form' ? { form: 'approval' } : {}),
    };
    const resume = async (cursor: WorkflowWaitContext) => {
      const store = createEscalationStore('question');
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          cwd,
          workflow,
          workflowRun: makeWorkflowRun('question', { metadata: { wait: cursor } }),
          priorCompletedNodes: prior,
        })
      );
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
      return store;
    };
    const resumed = await resume(answered);
    if (change === 'none' || change === 'body') {
      expect(resumed.completeWorkflowRun).toHaveBeenCalledTimes(1);
      expect(resumed.pauseWorkflowRunForWait).not.toHaveBeenCalled();
      expect(persistedEvents(resumed).some(e => e.step_name === 'grp.question')).toBe(false);
    } else {
      expect(resumed.pauseWorkflowRunForWait).toHaveBeenCalledTimes(1);
      expect(resumed.completeWorkflowRun).not.toHaveBeenCalled();
      expect(persistedEvents(resumed).some(e => e.step_name === 'after')).toBe(false);
      const fresh = readAttentionWait(resumed.getState().metadata.wait);
      expect(fresh).toMatchObject({
        owner: 'loop_group',
        nodeId: 'grp',
        bodyWaitId: 'ask',
        iteration: 1,
        form: 'select',
        sessionId: wait.sessionId,
        sessionProvider: wait.sessionProvider,
        bodySessionCursorAncestry: wait.bodySessionCursorAncestry,
        message: current.message,
        options: current.options,
        reaskedFrom: wait.pauseId,
      });
      expect(fresh.answer).toBeUndefined();
      expect(fresh.pauseId).not.toBe(wait.pauseId);
      expectWaitInvocation(persistedEvents(resumed), change === 'nested');
      await Bun.write(source, JSON.stringify({ ...current, message: 'Changed again' }));
      const final = await resume({
        ...fresh,
        answer: { decision: 'approve', text: '' },
      });
      expect(final.completeWorkflowRun).toHaveBeenCalledTimes(1);
      expect(final.pauseWorkflowRunForWait).not.toHaveBeenCalled();
    }
  });
}

test('keeps prior-iteration question references without replaying body work', async () => {
  const counter = join(cwd, 'counter');
  const literal = '$INPUTS.missing';
  await Bun.write(counter, literal);
  const workflow = ready(
    workflowDefinitionSchema.parse({
      name: 'prior-question',
      description: 'Prior question snapshot',
      nodes: [
        {
          id: 'grp',
          loop_group: {
            max_iterations: 3,
            until_bash: 'test $ask.output.text = done',
            nodes: [
              { id: 'work', bash: `printf x >> '${counter}'; cat '${counter}'` },
              {
                id: 'ask',
                depends_on: ['work'],
                wait: {
                  attention:
                    'Previous: $LOOP_PREV.work.output; reply: $LOOP_USER_INPUT; current: $work.output',
                },
              },
            ],
          },
        },
      ],
    })
  );
  const history: WorkflowEventRow[] = [];
  const execute = async (wait?: WorkflowWaitContext, output?: string) => {
    const store = createEscalationStore('prior');
    store.listEventsForRuns.mockResolvedValue(new Map([['prior', history]]));
    store.getDagResumeSnapshot.mockResolvedValue(await foldDagResumeSnapshot(history, 'prior'));
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd,
        workflow,
        workflowRun: makeWorkflowRun('prior', { metadata: wait ? { wait } : {} }),
        priorCompletedNodes: output ? new Map([['grp.work', { output }]]) : undefined,
      })
    );
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    const completedWaits = store.clearWorkflowWaitContext.mock.calls.map(
      ([id, , completion]) => waitCompletionEvents(id, completion).node
    );
    history.push(
      ...[...completedWaits, ...persistedEvents(store)].map((event, index) => ({
        ...event,
        step_name: event.step_name ?? null,
        data: event.data ?? {},
        id: String(history.length + index),
        step_index: null,
        created_at: new Date().toISOString(),
      }))
    );
    if (store.getState().status === 'paused') {
      const snapshot = await foldDagResumeSnapshot(history, 'prior');
      expect(snapshot.completedNodeOutputs.has('grp.ask')).toBe(false);
    }
    return store;
  };
  const first = await execute();
  const firstWait = readAttentionWait(first.getState().metadata.wait);
  const second = await execute({ ...firstWait, answer: { text: 'again' } }, `${literal}x`);
  const secondWait = readAttentionWait(second.getState().metadata.wait);
  expect(secondWait).toMatchObject({
    iteration: 2,
    message: `Previous: ${literal}x; reply: ; current: ${literal}xx`,
    loopQuestionReferences: { '$LOOP_PREV.work.output': `${literal}x`, $LOOP_USER_INPUT: '' },
  });
  const last = await execute({ ...secondWait, answer: { text: 'done' } }, `${literal}xx`);
  expect(last.completeWorkflowRun).toHaveBeenCalledTimes(1);
  expect(last.pauseWorkflowRunForWait).not.toHaveBeenCalled();
  expect(await Bun.file(counter).text()).toBe(`${literal}xx`);
});

for (const reference of [undefined, '$LOOP_PREV.work.output', '$LOOP_USER_INPUT']) {
  test(`legacy loop answer without snapshot: ${reference ?? 'literal question'}`, async () => {
    const workflow = ready(
      workflowDefinitionSchema.parse({
        name: 'legacy-question',
        description: 'Missing prior scope',
        nodes: [
          {
            id: 'grp',
            loop_group: {
              max_iterations: 2,
              until_bash: 'true',
              nodes: [
                { id: 'work', bash: 'printf work' },
                {
                  id: 'ask',
                  depends_on: ['work'],
                  wait: {
                    attention: reference === undefined ? 'Question old' : `Question ${reference}`,
                  },
                },
              ],
            },
          },
        ],
      })
    );
    const store = createEscalationStore('legacy');
    seedPreviousLoopGroupPass(
      store,
      'legacy',
      'grp',
      1,
      new Map([
        ['grp.work', { output: 'work' }],
        ['grp.ask', { output: '{"text":"again"}' }],
      ])
    );
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd,
        workflow,
        workflowRun: makeWorkflowRun('legacy', {
          metadata: {
            wait: {
              owner: 'loop_group',
              nodeId: 'grp',
              bodyWaitId: 'ask',
              iteration: 2,
              sessionId: null,
              sessionProvider: null,
              kind: 'attention',
              waitingSince: new Date().toISOString(),
              message: 'Question old',
              answer: { text: 'done' },
            },
          },
        }),
        priorCompletedNodes: new Map([['grp.work', { output: 'work' }]]),
      })
    );
    if (reference === undefined) {
      expect(store.completeWorkflowRun).toHaveBeenCalledTimes(1);
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
    } else {
      expect(store.completeWorkflowRun).not.toHaveBeenCalled();
      expect(store.failWorkflowRun).toHaveBeenCalledWith(
        'legacy',
        expect.stringContaining('Restart the run to ask a fresh question'),
        expect.objectContaining({ exitReason: 'node_error' })
      );
    }
  });
}
