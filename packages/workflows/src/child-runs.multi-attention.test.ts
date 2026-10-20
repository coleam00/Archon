// @archon-test-isolated
import { makeDeps, makePlatform } from './child-runs/test-utils';
import { providerRegistry } from '@archon/providers';
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { executeWorkflow } from './executor';
import { hydrateResumableRun } from './run-resume';
import { discoverWorkflows } from './workflow-discovery';
import { createFileWorkflowStore } from './file-store';
import { listAttentionQueue } from './attention-queue';
import { runAttention } from './schemas/workflow-run';

const roots = trackTempRoots();
const originalHome = process.env.ARCHON_HOME;
afterEach(() => {
  if (originalHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalHome;
});

async function questionsFixture(questions: { key: string; message: string }[]) {
  const root = roots(await mkdtemp(join(tmpdir(), 'multi-attention-')));
  const cwd = join(root, 'project');
  process.env.ARCHON_HOME = join(root, 'home');
  const workflows = join(cwd, '.archon', 'workflows');
  await mkdir(workflows, { recursive: true });
  await writeFile(
    join(workflows, 'question.yaml'),
    `
name: question
description: one independent question
inputs:
  question: { required: true }
returns: apply
nodes:
  - id: question
    bash: printf '%s' "$INPUTS_QUESTION"
    output_format:
      type: object
      properties:
        key: { type: string }
        message: { type: string }
      required: [key, message]
  - id: ask
    depends_on: [question]
    wait:
      attention: "$question.output.message"
      form: select
      options: [{id: accept}, {id: defer}]
  - id: apply
    depends_on: [ask]
    bash: printf '%s' '{"key":"$question.output.key","decision":"$ask.output.decision"}'
    output_format:
      type: object
      properties:
        key: { type: string }
        decision: { type: string }
      required: [key, decision]
`
  );
  await writeFile(
    join(workflows, 'questions.yaml'),
    `
name: questions
description: independent questions in one pass
nodes:
  - id: list
    bash: >-
      printf '%s' '${JSON.stringify(questions)}'
  - id: answers
    depends_on: [list]
    workflow: question
    fan_out:
      items: "$list.output"
      as: question
      max_parallel: all
`
  );
  const discover = async (name: string) => {
    const found = await discoverWorkflows(cwd, {
      providers: providerRegistry,
      loadDefaults: false,
    });
    const wf = found.workflows.find(w => w.workflow.name === name);
    if (!wf) throw new Error(JSON.stringify(found.errors));
    return wf.workflow;
  };
  return { root, cwd, discover };
}

test('all questions open together and apply independently, second first, across a reopened store', async () => {
  const { root, cwd, discover } = await questionsFixture([
    { key: 'first', message: 'First? Recommended accept' },
    { key: 'second', message: 'Second? Recommended defer' },
  ]);
  let store = await createFileWorkflowStore({ root: join(root, 'store') });
  let deps = makeDeps(store);
  const started = await executeWorkflow(
    deps,
    makePlatform(),
    'platform',
    cwd,
    await discover('questions'),
    'questions',
    { conversationId: 'conversation' }
  );
  expect(started.success && 'paused' in started && started.paused).toBe(true);
  if (!started.workflowRunId) throw new Error('Expected parent run');
  const parentId = started.workflowRunId;
  const queue = () => listAttentionQueue({ store, branchOf: async () => null });
  const items = (await queue())
    .filter(item => item.kind === 'attention')
    .sort((a, b) => a.fanOut!.index - b.fanOut!.index);
  expect(items).toHaveLength(2);
  const [first, second] = items;
  expect(items.map(item => item.fanOut)).toEqual([
    { parentRunId: parentId, nodeId: 'answers', index: 0 },
    { parentRunId: parentId, nodeId: 'answers', index: 1 },
  ]);
  expect(items.map(item => item.message)).toEqual([
    'First? Recommended accept',
    'Second? Recommended defer',
  ]);
  const firstBefore = await store.getWorkflowRun(first.runId);
  const answer = async (runId: string, decision: string) => {
    const run = (await store.getWorkflowRun(runId))!;
    const attention = runAttention(run);
    if (attention?.kind !== 'attention') throw new Error('Expected attention');
    const write = {
      pauseId: attention.occurrence,
      answer: { decision, text: '' },
      answeredVia: 'cli' as const,
      answeredAt: new Date().toISOString(),
    };
    expect(await store.answerAttentionWait(runId, write)).toEqual({ answered: true });
    expect(await store.answerAttentionWait(runId, write)).toEqual({ answered: false });
    const hydrated = await hydrateResumableRun(deps, (await store.getWorkflowRun(runId))!);
    expect(hydrated).not.toBeNull();
    const done = await executeWorkflow(
      deps,
      makePlatform(),
      'platform',
      cwd,
      await discover('question'),
      run.user_message,
      { conversationId: 'conversation' },
      { ...hydrated! }
    );
    expect(done.success).toBe(true);
    expect((await store.getWorkflowRun(runId))?.status).toBe('completed');
  };
  await answer(second.runId, 'defer');
  expect((await store.getWorkflowRun(parentId))?.status).toBe('paused');
  expect((await store.getWorkflowRun(first.runId))?.metadata.wait).toEqual(
    firstBefore?.metadata.wait
  );
  expect(await queue()).toEqual([first]);
  expect(
    (await store.listWorkflowEvents(first.runId)).filter(e => e.step_name === 'apply')
  ).toEqual([]);

  store = await createFileWorkflowStore({ root: join(root, 'store') });
  deps = makeDeps(store);
  expect(await queue()).toEqual([first]);
  expect((await store.getWorkflowRun(second.runId))?.status).toBe('completed');
  await answer(first.runId, 'accept');
  expect((await store.getWorkflowRun(parentId))?.status).toBe('completed');
  expect((await store.findChildRuns(parentId)).map(run => run.id).sort()).toEqual(
    items.map(item => item.runId).sort()
  );
  expect(await queue()).toEqual([]);
  const events = await store.listWorkflowEvents(parentId);
  expect(
    events.find(e => e.event_type === 'node_completed' && e.step_name === 'answers')?.data
      .structured_output
  ).toEqual([
    { key: 'first', decision: 'accept' },
    { key: 'second', decision: 'defer' },
  ]);
  for (const item of items) {
    const childEvents = await store.listWorkflowEvents(item.runId);
    const answered = childEvents.filter(e => e.event_type === 'wait_answered');
    expect(answered).toHaveLength(1);
    expect(answered[0].data.occurrence).toBe(item.occurrence);
    expect(
      childEvents.filter(e => e.event_type === 'node_completed' && e.step_name === 'apply')
    ).toHaveLength(1);
  }
});

test('all opens every question even when the list exceeds the default window', async () => {
  const questions = Array.from({ length: 6 }, (_, i) => ({
    key: String(i),
    message: `Question ${i}?`,
  }));
  const { root, cwd, discover } = await questionsFixture(questions);
  const store = await createFileWorkflowStore({ root: join(root, 'store') });
  const result = await executeWorkflow(
    makeDeps(store),
    makePlatform(),
    'platform',
    cwd,
    await discover('questions'),
    'questions',
    { conversationId: 'conversation' }
  );
  expect(result.success && 'paused' in result && result.paused).toBe(true);
  const items = await listAttentionQueue({ store, branchOf: async () => null });
  expect(items).toHaveLength(questions.length);
  expect(items.map(item => item.fanOut?.index).sort()).toEqual([0, 1, 2, 3, 4, 5]);
});
