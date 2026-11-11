// @archon-test-isolated
import { expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { createFileWorkflowStore } from '../../../file-store/store';
import { executeDagWorkflow } from '../../../dag-executor';
import { hydrateResumableRun } from '../../../run-resume';
import { dagNodeSchema, isWorkflowWaitContext } from '../../../schemas';
import { createMockDeps, dagOptions, mockSendQueryDag } from '../../test-utils';

// `on_exhausted: complete` across a real store: what the first pass records is what a
// resume reads back, and an answer that extends the limit is judged at the new limit.

type FileStore = Awaited<ReturnType<typeof createFileWorkflowStore>>;

async function startRun(
  root: string,
  name: string,
  nodes: Parameters<typeof dagOptions>[0]['workflow']['nodes']
) {
  const store = await createFileWorkflowStore({ root });
  const created = await store.createWorkflowRun({ workflow_name: name, user_message: '' });
  const run = await store.claimPendingWorkflowRun(created.id, root);
  if (!run) throw new Error('Claim failed');
  const options = dagOptions({
    deps: createMockDeps(store),
    cwd: root,
    workflowRun: run,
    workflow: { name, nodes },
  });
  return { store, run, options };
}

async function resume(store: FileStore, options: ReturnType<typeof dagOptions>): Promise<void> {
  const candidate = await store.getWorkflowRun(options.workflowRun.id);
  if (!candidate) throw new Error('Missing run');
  const resumed = await hydrateResumableRun({ store }, candidate);
  if (!resumed) throw new Error('Missing resume');
  await executeDagWorkflow({ ...options, ...resumed, workflowRun: resumed.preCreatedRun });
}

test('a resume reads the exhausted loop from the record its first pass wrote and runs no iteration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'loop-exhausted-resume-'));
  try {
    let calls = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      calls++;
      yield {
        type: 'result',
        sessionId: `s-${String(calls)}`,
        structuredOutput: { done: false, note: `pass ${String(calls)}` },
      };
    });
    const marker = join(root, 'report-ran-once').replace(/\\/g, '/');
    const { store, run, options } = await startRun(root, 'exhausted-resume', [
      dagNodeSchema.parse({
        id: 'work',
        output_format: {
          type: 'object',
          properties: { done: { type: 'boolean' }, note: { type: 'string' } },
          required: ['done', 'note'],
        },
        loop: {
          prompt: 'go',
          until_field: 'done',
          max_iterations: 2,
          on_exhausted: 'complete',
        },
      }),
      // Fails the first pass after the loop completed, so the run is resumed.
      dagNodeSchema.parse({
        id: 'report',
        depends_on: ['work'],
        bash: `if [ -f '${marker}' ]; then printf 'note=%s' $work.output.note; else touch '${marker}'; exit 1; fi`,
      }),
    ]);

    await executeDagWorkflow(options);
    expect((await store.getWorkflowRun(run.id))?.status).toBe('failed');
    expect(calls).toBe(2);

    await resume(store, options);

    expect(calls).toBe(2);
    expect((await store.getWorkflowRun(run.id))?.status).toBe('completed');
    const events = await store.listWorkflowEvents(run.id);
    const report = events.filter(
      event => event.step_name === 'report' && event.event_type === 'node_completed'
    );
    expect(report.map(event => event.data.node_output)).toEqual(['note=pass 2']);
    expect(
      events.find(event => event.step_name === 'work' && event.event_type === 'node_completed')
        ?.data
    ).toMatchObject({ maxIterations: 2 });
  } finally {
    await removeTempTree(root);
  }
});

test('an answer past the limit runs one iteration, and its exhaustion completes at the extended limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'loop-group-exhausted-answer-'));
  try {
    let calls = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      calls++;
      yield { type: 'agent_message_chunk', text: calls === 1 ? 'first' : 'second' };
      yield { type: 'result', sessionId: `s-${String(calls)}` };
    });
    const { store, run, options } = await startRun(root, 'exhausted-answer', [
      dagNodeSchema.parse({
        id: 'grp',
        loop_group: {
          max_iterations: 1,
          until: 'DONE',
          on_exhausted: 'complete',
          nodes: [
            { id: 'work', prompt: 'Produce a value' },
            // Asks on the first iteration only, so the extra iteration ends unanswered.
            {
              id: 'check',
              depends_on: ['work'],
              when: "$work.output == 'first'",
              wait: { attention: 'Continue?' },
            },
          ],
        },
      }),
    ]);

    await executeDagWorkflow(options);
    const paused = await store.getWorkflowRun(run.id);
    const wait = paused?.metadata.wait;
    if (!isWorkflowWaitContext(wait) || wait.kind !== 'attention' || !wait.pauseId)
      throw new Error('Missing attention wait');
    await store.answerAttentionWait(run.id, {
      pauseId: wait.pauseId,
      answer: { text: 'one more' },
      answeredVia: 'web',
      answeredAt: new Date().toISOString(),
    });

    await resume(store, options);

    expect(calls).toBe(2);
    expect((await store.getWorkflowRun(run.id))?.status).toBe('completed');
    const events = await store.listWorkflowEvents(run.id);
    expect(events.some(event => event.event_type === 'node_failed')).toBe(false);
    expect(
      events.find(event => event.step_name === 'grp' && event.event_type === 'node_completed')?.data
    ).toMatchObject({ node_output: 'second', maxIterations: 2 });
  } finally {
    await removeTempTree(root);
  }
});
