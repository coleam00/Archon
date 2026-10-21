// @archon-test-isolated
import { expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { createFileWorkflowStore } from '../../../file-store/store';
import { executeDagWorkflow } from '../../../dag-executor';
import { hydrateResumableRun } from '../../../run-resume';
import { readNodeRecordEvent } from '../../../node-record-reader';
import { finishNodeExecution } from '../../../node-execution';
import { serializeNodeStateRecord } from '../../../node-record-serialization';
import { dagNodeSchema, isApprovalContext, isWorkflowWaitContext } from '../../../schemas';
import { createMockDeps, dagOptions, mockSendQueryDag } from '../../test-utils';

async function answerAndResume(
  store: Awaited<ReturnType<typeof createFileWorkflowStore>>,
  options: ReturnType<typeof dagOptions>
): Promise<void> {
  const run = options.workflowRun;
  const paused = await store.getWorkflowRun(run.id);
  const approval = paused?.metadata.approval;
  expect(paused?.status).toBe('paused');
  if (!paused) throw new Error('Missing paused run');
  if (isApprovalContext(approval)) {
    expect(approval.iteration).toBe(2);
    const events = await store.listWorkflowEvents(run.id);
    const suspended = [...events]
      .reverse()
      .find(e => e.step_name?.endsWith('.check') && e.event_type === 'node_suspended');
    const execution = suspended && readNodeRecordEvent(suspended)?.metadata;
    if (!execution) throw new Error('No gate execution');
    const answer = { decision: 'approve', text: '' };
    const completed = serializeNodeStateRecord(
      finishNodeExecution(
        execution,
        { status: 'completed' },
        {
          output: { text: JSON.stringify(answer), structured: answer },
        }
      )
    );
    await store.resolveApprovalGate(
      run.id,
      { ...paused.metadata, approval: { ...approval, resolved: 'approved' } },
      [completed]
    );
  } else {
    const wait = paused.metadata.wait;
    if (!isWorkflowWaitContext(wait) || wait.kind !== 'attention' || !wait.pauseId)
      throw new Error('Missing attention wait');
    expect(wait.owner).toBe('loop_group');
    await store.answerAttentionWait(run.id, {
      pauseId: wait.pauseId,
      answer: { text: 'continue' },
      answeredVia: 'web',
      answeredAt: new Date().toISOString(),
    });
  }
  const candidate = await store.getWorkflowRun(run.id);
  if (!candidate) throw new Error('Missing run');
  const resumed = await hydrateResumableRun({ store }, candidate);
  if (!resumed) throw new Error('Missing resume');
  await executeDagWorkflow({ ...options, ...resumed, workflowRun: resumed.preCreatedRun });
}

for (const pause of [false, true]) {
  test(`completion keeps preceding iteration after terminal approval: pause=${pause}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'loop-completion-'));
    try {
      let count = 0;
      mockSendQueryDag.mockImplementation(async function* () {
        yield {
          type: 'agent_message_chunk',
          text: ++count === 1 ? 'first<promise>hint</promise>' : 'second',
        };
        yield { type: 'result', sessionId: `session-${count}` };
      });
      const store = await createFileWorkflowStore({ root });
      const created = await store.createWorkflowRun({
        workflow_name: 'completion',
        user_message: '',
      });
      const run = await store.claimPendingWorkflowRun(created.id, root);
      if (!run) throw new Error('Claim failed');
      const options = dagOptions({
        deps: createMockDeps(store),
        cwd: root,
        workflowRun: run,
        workflow: {
          name: 'completion',
          nodes: [
            dagNodeSchema.parse({
              id: 'grp',
              loop_group: {
                max_iterations: 2,
                until_bash: `test $work.output = second && test $LOOP_PREV.work.output = 'first<promise>hint</promise>' && test "$(printenv LOOP_PREV_OUTPUT)" = first`,
                nodes: [
                  { id: 'work', prompt: 'Produce next value' },
                  {
                    id: 'check',
                    depends_on: ['work'],
                    when: pause ? "$work.output == 'second'" : "$work.output == 'never'",
                    approval: { message: 'Continue?', decisions: [{ id: 'approve' }] },
                  },
                ],
              },
            }),
          ],
        },
      });
      await executeDagWorkflow(options);
      if (pause) {
        await answerAndResume(store, options);
      }
      expect((await store.getWorkflowRun(run.id))?.status).toBe('completed');
      expect(count).toBe(2);
    } finally {
      await removeTempTree(root);
    }
  });
}

for (const terminal of ['approval', 'wait'] as const) {
  test(`nested ${terminal} completion restores both full spills`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'nested-loop-completion-'));
    try {
      let outerCount = 0;
      let innerCount = 0;
      mockSendQueryDag.mockImplementation(async function* (prompt) {
        const text = prompt.includes('Outer value')
          ? ++outerCount === 1 && terminal === 'approval'
            ? 'old'
            : 'new'
          : (outerCount === 1 && terminal === 'approval' ? 'old-' : '') +
            (++innerCount % 2 === 1 ? 'first' : 'second');
        yield { type: 'agent_message_chunk', text };
        yield { type: 'result', sessionId: `session-${outerCount}-${innerCount}` };
      });
      const store = await createFileWorkflowStore({ root });
      const created = await store.createWorkflowRun({ workflow_name: 'nested', user_message: '' });
      const run = await store.claimPendingWorkflowRun(created.id, root);
      if (!run) throw new Error('Claim failed');
      const options = dagOptions({
        deps: createMockDeps(store),
        cwd: root,
        workflowRun: run,
        workflow: {
          name: 'nested',
          nodes: [
            dagNodeSchema.parse({
              id: 'outer',
              loop_group: {
                max_iterations: 2,
                until_bash: 'test $outerWork.output = new',
                nodes: [
                  { id: 'outerWork', prompt: 'Outer value' },
                  {
                    id: 'grp',
                    depends_on: ['outerWork'],
                    loop_group: {
                      max_iterations: 2,
                      until_bash: `test $data.output.previous = $LOOP_PREV.work.output &&
                case $data.output.tail in *second-tail) true;; *) false;; esac &&
                test "$(printf %s $data.output | tail -c 13)" = 'second-tail"}' &&
                test "$(printf %s $LOOP_PREV.data.output | tail -c 12)" = 'first-tail"}' &&
                test "$(printenv LOOP_PREV_OUTPUT | tail -c 13 | tr -d '\n')" = 'first-tail"}'`,
                      nodes: [
                        { id: 'work', prompt: 'Inner value' },
                        {
                          id: 'data',
                          depends_on: ['work'],
                          bash: `value=$work.output
                  case "$value" in second) previous=first;; old-second) previous=old-first;; *) previous=none;; esac
                  printf '{"previous":"%s","padding":"' "$previous"
                  printf 'x%.0s' {1..40000}
                  printf '","tail":"%s-tail"}' "$value"`,
                        },
                        {
                          id: 'check',
                          depends_on: ['data'],
                          when: "$data.output.tail == 'second-tail'",
                          ...(terminal === 'approval'
                            ? { approval: { message: 'Continue?', decisions: [{ id: 'approve' }] } }
                            : { wait: { attention: 'Continue?' } }),
                        },
                      ],
                    },
                  },
                ],
              },
            }),
          ],
        },
      });
      await executeDagWorkflow(options);
      expect(innerCount).toBe(terminal === 'approval' ? 4 : 2);
      const events = await store.listWorkflowEvents(run.id);
      const spills = events.filter(
        e => e.step_name === 'outer.grp.data' && e.event_type === 'node_completed'
      );
      expect(spills).toHaveLength(terminal === 'approval' ? 4 : 2);
      expect(new Set(spills.map(e => e.data.node_output_spill_path)).size).toBe(
        terminal === 'approval' ? 4 : 2
      );
      await answerAndResume(store, options);
      expect((await store.getWorkflowRun(run.id))?.status).toBe('completed');
      expect(outerCount).toBe(terminal === 'approval' ? 3 : 2);
      expect(innerCount).toBe(terminal === 'approval' ? 4 : 2);
    } finally {
      await removeTempTree(root);
    }
  });
}

for (const missingHistory of [false, true]) {
  test(`non-completing resume keeps current snapshot; missing history refuses work: missing=${missingHistory}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'loop-next-iteration-'));
    try {
      let count = 0;
      mockSendQueryDag.mockClear();
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: ['first', 'second', 'third'][count++] };
        yield { type: 'result', sessionId: `session-${count}` };
      });
      const store = await createFileWorkflowStore({ root });
      const created = await store.createWorkflowRun({
        workflow_name: 'next-iteration',
        user_message: '',
      });
      const run = await store.claimPendingWorkflowRun(created.id, root);
      if (!run) throw new Error('Claim failed');
      const marker = join(root, 'resumed-predicate');
      const options = dagOptions({
        deps: createMockDeps(store),
        cwd: root,
        workflowRun: run,
        workflow: {
          name: 'next-iteration',
          nodes: [
            dagNodeSchema.parse({
              id: 'grp',
              loop_group: {
                max_iterations: 3,
                until_bash: `if test $work.output = second; then printf ran > '${marker}'; fi
            test $work.output = third && test $LOOP_PREV.work.output = second`,
                nodes: [
                  {
                    id: 'work',
                    prompt:
                      'Previous work: $LOOP_PREV.work.output; Previous answer: $LOOP_PREV.check.output',
                  },
                  {
                    id: 'check',
                    depends_on: ['work'],
                    when: "$work.output == 'second'",
                    approval: { message: 'Continue?', decisions: [{ id: 'approve' }] },
                  },
                ],
              },
            }),
          ],
        },
      });
      await executeDagWorkflow(options);
      if (missingHistory) {
        const readEvents = store.listEventsForRuns.bind(store);
        store.listEventsForRuns = async (ids, types) => {
          const events = await readEvents(ids, types);
          return new Map(
            [...events].map(([id, rows]) => [
              id,
              rows.filter(
                row =>
                  row.step_name !== 'grp.work' ||
                  readNodeRecordEvent(row)?.metadata?.invocation.loopPath[0]?.iteration !== 1
              ),
            ])
          );
        };
      }
      await answerAndResume(store, options);
      if (missingHistory) {
        expect((await store.getWorkflowRun(run.id))?.status).toBe('failed');
        const failure = (await store.listWorkflowEvents(run.id)).find(
          e => e.step_name === 'grp' && e.event_type === 'node_failed'
        );
        expect(failure?.data.error).toContain("cannot restore iteration 1 node 'work'");
        expect(await Bun.file(marker).exists()).toBe(false);
        expect(count).toBe(2);
      } else {
        expect((await store.getWorkflowRun(run.id))?.status).toBe('completed');
        expect(await Bun.file(marker).text()).toBe('ran');
        expect(count).toBe(3);
        expect(mockSendQueryDag.mock.calls[2][0]).toContain('Previous work: second');
        expect(mockSendQueryDag.mock.calls[2][0]).toContain('approve');
      }
    } finally {
      await removeTempTree(root);
    }
  });
}
