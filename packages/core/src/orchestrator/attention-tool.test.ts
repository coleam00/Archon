import { describe, test, expect, mock } from 'bun:test';
import { join } from 'node:path';
import { getArchonWorkspacesPath } from '@archon/paths';
import type {
  AttentionQueueItem,
  AttentionQueueItemWithoutRun,
  AttentionQueueSource,
} from '@archon/workflows/attention-queue';
import { projectRef } from '@archon/workflows/attention-queue';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import {
  authorizeRunAction,
  RunActionForbiddenError,
  type RunActor,
} from '../operations/run-authorization';
import type { WorkflowOperations } from '../operations/workflow-operations';
import { buildAttentionTool, type AttentionToolContext } from './attention-tool';

const operator: RunActor = { kind: 'operator' };
const WEB = {
  id: 'cb-web',
  name: 'acme/web',
  default_cwd: '/repos/web',
  repository_url: null,
  kind: 'repo' as const,
};
const API = {
  id: 'cb-api',
  name: 'acme/api',
  default_cwd: '/repos/api',
  repository_url: null,
  kind: 'repo' as const,
};

function pausedRun(
  id: string,
  codebase: typeof WEB,
  metadata: WorkflowRun['metadata']
): WorkflowRun {
  return {
    origin: { conversationId: 'conv-1' },
    id,
    workflow_name: 'deliver',
    status: 'paused',
    active_phase_started_at: null,
    started_at: new Date('2026-06-01T00:00:00.000Z'),
    completed_at: null,
    metadata,
    codebase_id: codebase.id,
    conversation_id: 'conv-1',
    parent_conversation_id: null,
    outcome: null,
    user_message: 'Run the workflow',
    last_activity_at: new Date('2026-06-01T00:00:00.000Z'),
    working_path: null,
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: join(getArchonWorkspacesPath(), ...codebase.name.split('/')),
    checkout_baseline: null,
    item_id: null,
  };
}

const ask = (pauseId: string, waitingSince: string): WorkflowRun['metadata'] => ({
  wait: {
    owner: 'node',
    nodeId: 'ask',
    kind: 'attention',
    waitingSince,
    message: 'Merge this pull request?',
    pauseId,
    form: 'select',
    options: [{ id: 'merge' }, { id: 'return' }],
    recommendation: { option: 'merge', why: 'Review is ready.' },
  },
});

const webAsk = pausedRun('run-web', WEB, ask('pause-web', '2026-06-02T10:00:00.000Z'));
const apiAsk = pausedRun('run-api', API, ask('pause-api', '2026-06-01T10:00:00.000Z'));
const webGate = pausedRun('run-gate', WEB, {
  approval: { nodeId: 'review', pauseId: 'pause-gate', message: 'Ship it?' },
});

function harness(
  runs: WorkflowRun[],
  codebaseId: string | null = null,
  actor: RunActor = operator,
  itemsWithoutRun: AttentionQueueItemWithoutRun[] = []
) {
  const byId = new Map(runs.map(run => [run.id, run]));
  const queue: AttentionQueueSource = {
    store: {
      listAttentionQueueRows: async () => runs,
      getWorkflowRun: async id => byId.get(id) ?? null,
      getWorkflowRunForAttention: async id => byId.get(id) ?? null,
      getCodebase: async id => [WEB, API].find(codebase => codebase.id === id) ?? null,
      getItem: async () => null,
    },
    branchOf: async () => null,
    itemsWithoutRun: async () => itemsWithoutRun,
  };
  const answerWorkflow = mock<WorkflowOperations['answerWorkflow']>(async () => {
    throw new Error('the tool reads no result of an answer');
  });
  answerWorkflow.mockImplementation((async () => ({})) as never);
  const respondToWorkflow = mock<WorkflowOperations['respondToWorkflow']>(
    (async () => ({})) as never
  );
  const ctx: AttentionToolContext = {
    actor,
    operations: {
      answerWorkflow,
      respondToWorkflow,
      // The real rule, with no admin: an operator, or the user who started the run.
      assertRunActionAllowed: async (run, by, action) => {
        if (!authorizeRunAction(by, run.user_id, undefined))
          throw new RunActionForbiddenError(action, run.user_id);
      },
    },
    queue,
    resolveProject: async spec => {
      const codebase = [WEB, API].find(each => each.id === spec || each.name === spec);
      if (codebase === undefined) throw new Error(`No project matches '${spec}'.`);
      return projectRef(codebase.name, codebase);
    },
    codebaseId,
  };
  return { tool: buildAttentionTool(ctx), answerWorkflow, respondToWorkflow };
}

/** The items a list result carries: the JSON block between its count line and the answer guide. */
function listed(out: string): AttentionQueueItem[] {
  return JSON.parse(
    out.slice(out.indexOf('\n['), out.indexOf('\nAnswer an item'))
  ) as AttentionQueueItem[];
}

describe('attention tool', () => {
  test('a chat without a project lists every project, oldest first, as the queue describes each item', async () => {
    const { tool } = harness([webAsk, apiAsk, webGate]);
    const items = listed(await tool.handler({ action: 'list' }));

    expect(items.map(item => item.run?.id)).toEqual(['run-api', 'run-web', 'run-gate']);
    expect(items[0]).toMatchObject({
      kind: 'attention',
      run: { id: 'run-api', occurrence: 'pause-api' },
      message: 'Merge this pull request?',
      form: 'select',
      options: [{ id: 'merge' }, { id: 'return' }],
      recommendation: { option: 'merge', why: 'Review is ready.' },
      project: { codebaseId: API.id, name: API.name },
    });
    expect(items[2]).toMatchObject({
      kind: 'awaiting_response',
      run: { occurrence: 'pause-gate' },
    });
    // Each item carries the reference an answer names it by.
    expect(items.map(item => item.ref)).toEqual([
      'run-api:pause-api',
      'run-web:pause-web',
      'run-gate:pause-gate',
    ]);
  });

  test("a project chat lists its own project unless asked for 'all' or another project", async () => {
    const { tool } = harness([webAsk, apiAsk], WEB.id);

    expect(listed(await tool.handler({ action: 'list' })).map(i => i.run?.id)).toEqual(['run-web']);
    expect(
      listed(await tool.handler({ action: 'list', project: 'all' })).map(i => i.run?.id)
    ).toEqual(['run-api', 'run-web']);
    expect(
      listed(await tool.handler({ action: 'list', project: API.name })).map(i => i.run?.id)
    ).toEqual(['run-api']);
  });

  test('a list shows a user only the items they may answer, and counts the rest', async () => {
    const mine = { ...webAsk, user_id: 'user-1' };
    const theirs = { ...apiAsk, user_id: 'user-2' };
    const { tool } = harness([mine, theirs], null, { kind: 'user', userId: 'user-1' });
    const out = await tool.handler({ action: 'list' });

    expect(listed(out).map(item => item.run?.id)).toEqual(['run-web']);
    expect(out).not.toContain('run-api');
    expect(out).toContain('1 more item(s) in every project are not listed');
  });

  test('a user who may not answer an item learns nothing about it from its reference', async () => {
    const theirs = { ...apiAsk, user_id: 'user-2' };
    const { tool, answerWorkflow } = harness([theirs], null, { kind: 'user', userId: 'user-1' });
    for (const item of ['run-api:pause-api', 'run-api:guessed', 'run-api']) {
      const out = await tool.handler({ action: 'answer', item, choose: '["merge"]' });
      expect(out).toContain(`nothing matches item '${item}'`);
      expect(out).not.toContain('Merge this pull request?');
      expect(out).not.toContain('pause-api:');
    }
    expect(answerWorkflow).not.toHaveBeenCalled();
  });

  test('one turn can answer several items, each pinned to the occurrence it was listed at', async () => {
    const { tool, answerWorkflow } = harness([webAsk, apiAsk]);
    await tool.handler({
      action: 'answer',
      item: 'run-web:pause-web',
      recommended: true,
    });
    const out = await tool.handler({
      action: 'answer',
      item: 'run-api:pause-api',
      choose: '["return"]',
      text: 'needs a test',
    });

    expect(answerWorkflow.mock.calls).toEqual([
      [
        'run-web',
        { recommended: true },
        operator,
        { via: 'attention_tool', expectedGate: { nodeId: 'ask', pauseId: 'pause-web' } },
      ],
      [
        'run-api',
        { choose: ['return'], text: 'needs a test' },
        operator,
        { via: 'attention_tool', expectedGate: { nodeId: 'ask', pauseId: 'pause-api' } },
      ],
    ]);
    // The result repeats the question, so the user sees what the answer went to.
    expect(out).toContain('> Merge this pull request?');
    expect(out).toContain('continues on its own while an Archon server is running');
  });

  test('an answer for an occurrence the item has left is refused', async () => {
    const { tool, answerWorkflow } = harness([webAsk]);
    const out = await tool.handler({
      action: 'answer',
      item: 'run-web:pause-earlier',
      choose: '["merge"]',
    });

    expect(out).toContain("'run-web:pause-web'");
    expect(answerWorkflow).not.toHaveBeenCalled();
  });

  test('a reference that names nothing is refused without a lookup by guesswork', async () => {
    const { tool, answerWorkflow } = harness([webAsk]);
    const out = await tool.handler({
      action: 'answer',
      item: 'no-such-run:pause-web',
      choose: '["merge"]',
    });

    expect(out).toContain("nothing matches item 'no-such-run:pause-web'");
    expect(answerWorkflow).not.toHaveBeenCalled();
  });

  test('a gate item is answered with one declared decision', async () => {
    const { tool, respondToWorkflow, answerWorkflow } = harness([webGate]);
    const refused = await tool.handler({
      action: 'answer',
      item: 'run-gate:pause-gate',
      recommended: true,
    });
    expect(refused).toContain('no recommendation');

    await tool.handler({
      action: 'answer',
      item: 'run-gate:pause-gate',
      choose: '["approve"]',
      text: 'ship it',
    });
    expect(respondToWorkflow.mock.calls).toEqual([
      [
        'run-gate',
        'approve',
        'ship it',
        operator,
        { via: 'attention_tool', expectedGate: { nodeId: 'review', pauseId: 'pause-gate' } },
      ],
    ]);
    expect(answerWorkflow).not.toHaveBeenCalled();
  });

  // Who may answer is the run's rule today, so an item no run holds is nobody's to answer yet.
  test('an item no run holds is counted, not listed, and takes no answer', async () => {
    const withoutRun: AttentionQueueItemWithoutRun = {
      kind: 'attention',
      ref: 'ask:1',
      project: null,
      revision: 1,
      labels: {},
      pausedAt: '2026-06-03T10:00:00.000Z',
      message: 'Ship the fix?',
      form: 'approval',
      options: [{ id: 'approve' }, { id: 'reject' }],
    };
    const { tool, answerWorkflow, respondToWorkflow } = harness([webAsk], null, operator, [
      withoutRun,
    ]);
    const out = await tool.handler({ action: 'list' });

    expect(listed(out).map(item => item.ref)).toEqual(['run-web:pause-web']);
    expect(out).toContain('1 more item(s) in every project are not listed');
    expect(out).not.toContain('Ship the fix?');
    expect(
      await tool.handler({ action: 'answer', item: 'ask:1', choose: '["approve"]' })
    ).toContain("nothing matches item 'ask:1'");
    expect(answerWorkflow).not.toHaveBeenCalled();
    expect(respondToWorkflow).not.toHaveBeenCalled();
  });
});
