import {
  mockGetWorkflowRun,
  mockListAttentionQueueRows,
  mockListWorkflowEvents,
  mockGetConversationById,
  mockFindLatestEnvironment,
  mockLabelAttentionWait,
  mockGetItemRuns,
  mockListEventsForRuns,
  mockListCodebases,
  mockListItemRulings,
  mockRecordItemRuling,
  mockWithdrawItemRuling,
  mockGetItemAsk,
  mockAnswerItemAsk,
  mockWithdrawItemAsk,
  mockGetUserById,
  makeUser,
  setSessionUserId,
  MOCK_RUNNING_RUN,
  makeDashboardWorkflowRun,
  makeApp,
} from '../test/api-workflow-runs-harness';
import { describe, test, expect } from 'bun:test';
import { itemReadSchema } from '@archon/workflows/item-read';
import type { StoredItemAsk } from '@archon/workflows/schemas/item-ask';
import {
  ItemRulingNotFoundError,
  ItemRulingOutsideProjectError,
  ItemRulingWithdrawnError,
  itemRulingSchema,
  type ItemRuling,
} from '@archon/workflows/schemas/item-ruling';
import type {
  WorkflowAttentionWaitContext,
  WorkflowRun,
} from '@archon/workflows/schemas/workflow-run';
import {
  workflowRunSchema as apiWorkflowRunSchema,
  runsNeedingAttentionResponseSchema,
} from './schemas/workflow.schemas';

test('the attention endpoint and detail expose the shared projection with wire dates', async () => {
  const run: WorkflowRun = {
    ...MOCK_RUNNING_RUN,
    status: 'paused',
    metadata: {
      wait: {
        owner: 'node',
        nodeId: 'hold',
        kind: 'attention',
        waitingSince: '2026-10-12T00:00:00.000Z',
        message: 'Rotate key',
      },
    },
  };
  mockListAttentionQueueRows.mockImplementationOnce(async () => [makeDashboardWorkflowRun(run)]);
  mockGetWorkflowRun.mockImplementationOnce(async () => run);
  const { app } = makeApp();
  const list = await app.request('/api/runs/attention');
  expect(list.status).toBe(200);
  const body = runsNeedingAttentionResponseSchema.parse(await list.json());
  expect(body.runs[0]?.attention).toEqual({
    kind: 'attention',
    runId: run.id,
    nodeId: 'hold',
    occurrence: 'legacy:hold',
    message: 'Rotate key',
    form: 'message',
    options: [],
  });
  mockListWorkflowEvents.mockResolvedValueOnce([]);
  mockGetConversationById.mockResolvedValueOnce(null);
  const detail = await app.request(`/api/workflows/runs/${run.id}`);
  expect(detail.status).toBe(200);
  const detailBody = (await detail.json()) as { run: unknown };
  expect(apiWorkflowRunSchema.parse(detailBody.run).attention).toEqual(body.runs[0]?.attention);
});

describe('the attention queue over HTTP', () => {
  const waitFor = (id: string, labels: Record<string, string>): WorkflowAttentionWaitContext => ({
    owner: 'node',
    nodeId: 'ask',
    kind: 'attention',
    waitingSince: '2026-10-14T00:00:00.000Z',
    message: 'CI is red. Retry?',
    pauseId: `pause-${id}`,
    form: 'approval',
    labels,
  });
  const attentionRun = (id: string, labels: Record<string, string>): WorkflowRun => ({
    ...MOCK_RUNNING_RUN,
    id,
    status: 'paused',
    metadata: { wait: waitFor(id, labels) },
  });
  const other = attentionRun('run-other', { ci: 'other' });
  const pr = attentionRun('run-pr', { ci: 'pr' });

  test('lists typed items with the console rows, filtered by label, and counts by label', async () => {
    mockListAttentionQueueRows.mockImplementation(async () => [
      makeDashboardWorkflowRun(other),
      makeDashboardWorkflowRun(pr),
    ]);
    mockFindLatestEnvironment.mockImplementation(async () => ({ branch_name: 'fix/ci' }));
    try {
      const { app } = makeApp();
      const list = await app.request('/api/runs/attention?label=ci%3Dother');
      expect(list.status).toBe(200);
      const body = runsNeedingAttentionResponseSchema.parse(await list.json());
      expect(body.items.map(item => item.run?.id)).toEqual(['run-other']);
      expect(body.runs.map(run => run.id)).toEqual(['run-other']);
      expect(body.items[0]).toMatchObject({
        kind: 'attention',
        ref: 'run-other:pause-run-other',
        form: 'approval',
        labels: { ci: 'other' },
        revision: 1,
        run: {
          id: 'run-other',
          occurrence: 'pause-run-other',
          fanOut: null,
          context: { workingPath: '/tmp/worktrees/feature', branch: 'fix/ci' },
        },
      });

      const counts = await app.request('/api/runs/attention?countBy=label%3Aci');
      expect(await counts.json()).toEqual({
        counts: {
          by: 'label',
          key: 'ci',
          counts: [
            { value: 'other', count: 1 },
            { value: 'pr', count: 1 },
          ],
        },
      });
      const twice = await app.request('/api/runs/attention?label=ci%3Dother&label=ci%3Dpr');
      expect(twice.status).toBe(400);
      expect(await twice.json()).toMatchObject({ error: "Label 'ci' is given twice" });
      expect((await app.request('/api/runs/attention?sort=newest')).status).toBe(400);
      expect((await app.request('/api/runs/attention?sort=age&countBy=project')).status).toBe(400);
      // Open items have no answerer; that count reads events and is the CLI's.
      const byAnswerer = await app.request('/api/runs/attention?countBy=answerer');
      expect(byAnswerer.status).toBe(400);
      expect(((await byAnswerer.json()) as { error: string }).error).toBe(
        "countBy must be 'project' or 'label:<key>', got 'answerer'"
      );
      expect((await app.request('/api/runs/attention?project=nowhere')).status).toBe(400);
    } finally {
      mockListAttentionQueueRows.mockReset();
      mockFindLatestEnvironment.mockReset();
    }
  });

  test('lists and reads each fan-out question by its child identity', async () => {
    const children = [0, 1].map(index => ({
      ...attentionRun(`child-${index}`, {}),
      parent_run_id: 'questions-parent',
      metadata: {
        parent_node_id: 'answers',
        child_index: index,
        wait: waitFor(`child-${index}`, {}),
      },
    }));
    mockListAttentionQueueRows.mockImplementation(async () =>
      children.map(makeDashboardWorkflowRun)
    );
    mockGetWorkflowRun.mockImplementation(async id => children.find(run => run.id === id) ?? null);
    try {
      const { app } = makeApp();
      const list = await app.request('/api/runs/attention');
      expect(list.status).toBe(200);
      const { items } = runsNeedingAttentionResponseSchema.parse(await list.json());
      expect(items.map(item => ({ runId: item.run?.id, fanOut: item.run?.fanOut }))).toEqual(
        children.map((run, index) => ({
          runId: run.id,
          fanOut: { parentRunId: 'questions-parent', nodeId: 'answers', index },
        }))
      );
      for (const item of items) {
        expect(item.kind).toBe('attention');
        const read = await app.request(`/api/runs/${item.run?.id}/attention`);
        expect(read.status).toBe(200);
        expect(await read.json()).toEqual({ item });
      }
    } finally {
      mockListAttentionQueueRows.mockReset();
      mockGetWorkflowRun.mockReset();
    }
  });

  test('reads one item, and refuses a stale label write with 409', async () => {
    mockGetWorkflowRun.mockImplementation(async id => (id === other.id ? other : null));
    try {
      const { app } = makeApp();
      const read = await app.request(`/api/runs/${other.id}/attention`);
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({
        item: { run: { id: other.id }, labels: { ci: 'other' } },
      });
      expect((await app.request('/api/runs/missing/attention')).status).toBe(404);

      const label = (body: unknown): Promise<Response> =>
        Promise.resolve(
          app.request(`/api/runs/${other.id}/attention/labels`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
        );
      const stale = await label({ occurrence: 'pause-old', set: { class: 'ci-other' } });
      expect(stale.status).toBe(409);
      expect(mockLabelAttentionWait).not.toHaveBeenCalled();

      mockLabelAttentionWait.mockImplementationOnce(async () => ({
        labeled: true,
        wait: { ...waitFor(other.id, { ci: 'other', class: 'ci-other' }), revision: 2 },
      }));
      const written = await label({ occurrence: `pause-${other.id}`, set: { class: 'ci-other' } });
      expect(written.status).toBe(200);
      expect(await written.json()).toEqual({
        runId: other.id,
        occurrence: `pause-${other.id}`,
        revision: 2,
        labels: { ci: 'other', class: 'ci-other' },
      });
      expect(mockLabelAttentionWait).toHaveBeenCalledWith(other.id, {
        pauseId: `pause-${other.id}`,
        set: { class: 'ci-other' },
        unset: [],
        via: 'api',
      });
    } finally {
      mockGetWorkflowRun.mockReset();
      mockLabelAttentionWait.mockReset();
    }
  });
});

test('batch list and counts preserve degraded reports even when scope or labels exclude readable items', async () => {
  const run = makeDashboardWorkflowRun({
    ...MOCK_RUNNING_RUN,
    id: 'valid-gate',
    status: 'paused',
    metadata: { approval: { nodeId: 'review', message: 'Approve?' } },
  });
  const degraded = ['bad-a', 'bad-b'].map(runId => ({
    type: 'degraded' as const,
    reason: 'run_unreadable' as const,
    runId,
  }));
  mockListAttentionQueueRows.mockImplementation(async () => [degraded[0]!, run, degraded[1]!]);
  try {
    const { app } = makeApp();
    for (const project of ['', '&project=_cwd/unknown']) {
      const warnings = project ? degraded.map(({ type, reason }) => ({ type, reason })) : degraded;
      const list = await app.request(`/api/runs/attention?all=false${project}`);
      expect(list.status).toBe(200);
      const body = runsNeedingAttentionResponseSchema.parse(await list.json());
      expect(body.degraded).toEqual(warnings);
      expect(body.runs.map(run => run.id)).toEqual(project ? [] : [run.id]);
      expect(body.items.map(item => item.run?.id)).toEqual(project ? [] : [run.id]);
      for (const countBy of ['', '&countBy=project']) {
        const response = await app.request(
          `/api/runs/attention?label=missing%3Dyes${project}${countBy}`
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(
          countBy
            ? { counts: { by: 'project', counts: [] }, degraded: warnings }
            : { runs: [], items: [], degraded: warnings }
        );
      }
    }
  } finally {
    mockListAttentionQueueRows.mockReset();
  }
});

describe('reading an item over HTTP', () => {
  const item = { id: 'item-row', projectKey: '_cwd/scratch', key: 'issues/7' };
  const asking: WorkflowRun = {
    ...MOCK_RUNNING_RUN,
    id: 'run-item',
    status: 'paused',
    item_id: item.id,
    metadata: {
      wait: {
        owner: 'node',
        nodeId: 'ask',
        kind: 'attention',
        waitingSince: '2026-10-14T00:00:00.000Z',
        message: 'Accept the scope?',
        pauseId: 'pause-1',
      },
    },
  };

  test('reads a known item by project and key, with its question and answers', async () => {
    mockGetItemRuns.mockImplementationOnce(async (projectKey, key) =>
      projectKey === item.projectKey && key === item.key
        ? { item, runs: [asking], descendantIds: [] }
        : null
    );
    mockListAttentionQueueRows.mockImplementationOnce(async () => [
      makeDashboardWorkflowRun(asking),
    ]);
    mockListEventsForRuns.mockImplementationOnce(
      async runIds =>
        new Map(
          runIds.map(id => [
            id,
            [
              {
                id: 'event-1',
                workflow_run_id: id,
                event_type: 'approval_received',
                step_index: null,
                step_name: 'review',
                data: { via: 'api', decision: 'approved', comment: 'ok' },
                created_at: '2026-10-13T00:00:00.000Z',
              },
            ],
          ])
        )
    );
    const { app } = makeApp();
    const response = await app.request(
      `/api/items?project=${encodeURIComponent(item.projectKey)}&key=${encodeURIComponent(item.key)}`
    );
    expect(response.status).toBe(200);
    const read = itemReadSchema.parse(await response.json());
    expect(read.item).toEqual(item);
    expect(read.runs.map(run => [run.id, run.status])).toEqual([['run-item', 'paused']]);
    expect(read.questions.map(question => question.run?.id)).toEqual(['run-item']);
    expect(read.answers).toMatchObject([{ kind: 'gate', runId: 'run-item', decision: 'approved' }]);
  });

  test('an unknown key is 404 and a missing parameter is 400', async () => {
    const { app } = makeApp();
    const unknown = await app.request(
      `/api/items?project=${encodeURIComponent(item.projectKey)}&key=nope`
    );
    expect(unknown.status).toBe(404);
    expect((await app.request('/api/items?key=nope')).status).toBe(400);
  });

  test('a database failure while resolving the project is an opaque 500, not a 400', async () => {
    mockListCodebases.mockImplementationOnce(async () => {
      throw new Error('connection refused at 10.0.0.5:5432');
    });
    const { app } = makeApp();
    const response = await app.request(
      `/api/items?project=${encodeURIComponent(item.projectKey)}&key=${encodeURIComponent(item.key)}`
    );
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('10.0.0.5');
  });
});

describe('rulings on an item over HTTP', () => {
  const project = '_cwd/scratch';
  const ruling = (fields: Partial<ItemRuling> = {}): ItemRuling => ({
    kind: 'ruling',
    id: 'ruling-1',
    text: 'leave the chat readers for a follow-up',
    at: '2026-11-15T10:00:00.000Z',
    via: 'api',
    by: null,
    fromRun: null,
    withdrawn: null,
    ...fields,
  });
  const post = (path: string, body: unknown) =>
    makeApp().app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  test('the operator records a ruling with no question asked, under the name it declares', async () => {
    mockRecordItemRuling.mockImplementationOnce(async input =>
      ruling({ via: input.via, by: input.by })
    );
    const response = await post('/api/items/rulings', {
      project,
      key: 'issues/7',
      text: 'leave the chat readers for a follow-up',
      as: 'triage-agent',
    });
    expect(response.status).toBe(201);
    expect(itemRulingSchema.parse(await response.json())).toMatchObject({
      via: 'api',
      by: { declared: 'triage-agent' },
    });
    expect(mockRecordItemRuling.mock.calls.at(-1)?.[0]).toMatchObject({
      projectKey: project,
      key: 'issues/7',
      text: 'leave the chat readers for a follow-up',
    });
  });

  test('a user who is not an admin is refused; an admin is recorded as the user', async () => {
    setSessionUserId('member');
    try {
      const refused = await post('/api/items/rulings', { project, key: 'issues/7', text: 'no' });
      expect(refused.status).toBe(403);
      mockGetUserById.mockImplementationOnce(async id => ({ ...makeUser(id), role: 'admin' }));
      mockRecordItemRuling.mockImplementationOnce(async input => ruling({ by: input.by }));
      const recorded = await post('/api/items/rulings', {
        project,
        key: 'issues/7',
        text: 'yes',
        as: 'ignored',
      });
      expect(recorded.status).toBe(201);
      expect(itemRulingSchema.parse(await recorded.json()).by).toEqual({
        userId: 'user-from-member',
      });
    } finally {
      setSessionUserId(undefined);
    }
  });

  test('blank text is 400, and an unknown project is 400', async () => {
    expect((await post('/api/items/rulings', { project, key: 'k', text: '  ' })).status).toBe(400);
    mockListCodebases.mockImplementationOnce(async () => []);
    expect(
      (await post('/api/items/rulings', { project: 'no-such', key: 'k', text: 'x' })).status
    ).toBe(400);
  });

  test('withdrawing answers the withdrawn ruling, 404 for no such ruling, 409 when already withdrawn', async () => {
    const withdrawn = ruling({
      withdrawn: { at: '2026-11-15T11:00:00.000Z', via: 'api', by: null, fromRun: null },
    });
    mockWithdrawItemRuling.mockImplementationOnce(async () => withdrawn);
    const response = await post('/api/items/rulings/ruling-1/withdraw', {});
    expect(response.status).toBe(200);
    expect(itemRulingSchema.parse(await response.json())).toEqual(withdrawn);
    expect(mockWithdrawItemRuling.mock.calls.at(-1)?.[0]).toMatchObject({
      rulingId: 'ruling-1',
      via: 'api',
    });
    mockWithdrawItemRuling.mockImplementationOnce(async () => {
      throw new ItemRulingNotFoundError('nope');
    });
    expect((await post('/api/items/rulings/nope/withdraw', {})).status).toBe(404);
    mockWithdrawItemRuling.mockImplementationOnce(async () => {
      throw new ItemRulingWithdrawnError('ruling-1');
    });
    expect((await post('/api/items/rulings/ruling-1/withdraw', {})).status).toBe(409);
  });

  test('a withdrawal that names a project passes it on, and a ruling outside it is 400', async () => {
    mockWithdrawItemRuling.mockImplementationOnce(async () => {
      throw new ItemRulingOutsideProjectError('ruling-1', 'scratch');
    });
    const refused = await post('/api/items/rulings/ruling-1/withdraw', { project });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toContain('outside project');
    expect(mockWithdrawItemRuling.mock.calls.at(-1)?.[0]).toMatchObject({
      rulingId: 'ruling-1',
      projectKey: expect.any(String),
    });
    // Without a project the withdrawal is not scoped.
    mockWithdrawItemRuling.mockImplementationOnce(async () => ruling());
    await post('/api/items/rulings/ruling-1/withdraw', {});
    expect(mockWithdrawItemRuling.mock.calls.at(-1)?.[0]).not.toHaveProperty('projectKey');
  });

  test('reading the item shows its rulings', async () => {
    const item = { id: 'item-row', projectKey: project, key: 'issues/8' };
    mockGetItemRuns.mockImplementationOnce(async () => ({ item, runs: [], descendantIds: [] }));
    mockListItemRulings.mockImplementationOnce(async () => [ruling()]);
    mockListAttentionQueueRows.mockImplementationOnce(async () => []);
    const response = await makeApp().app.request(
      `/api/items?project=${encodeURIComponent(project)}&key=issues%2F8`
    );
    expect(itemReadSchema.parse(await response.json()).answers).toEqual([ruling()]);
  });
});

describe('asks answered and withdrawn by ref over HTTP', () => {
  const left: WorkflowRun = { ...MOCK_RUNNING_RUN, status: 'completed' };
  const open: StoredItemAsk = {
    id: 'a1',
    itemId: 'item-1',
    runId: left.id,
    workflowName: 'plan',
    position: 0,
    ask: {
      question: 'Keep the flag?',
      context: 'Two readings.',
      options: [
        { id: 'keep', does: 'Keep it.', cost: 'One more flag.' },
        { id: 'drop', does: 'Drop it.', cost: 'Old configs break.' },
      ],
      recommendation: { option: 'keep', why: 'Nothing needs it gone.' },
      artifacts: [],
    },
    openedAt: '2026-11-16T10:00:00.000Z',
    closed: null,
  };
  const answered: StoredItemAsk = {
    ...open,
    closed: {
      as: 'answered',
      answer: { decision: 'keep', text: '' },
      act: { at: '2026-11-16T11:00:00.000Z', via: 'api', by: null, fromRun: null },
    },
  };
  const post = (path: string, body: object) =>
    makeApp().app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const withAsk = (ask: StoredItemAsk | null): void => {
    mockGetItemAsk.mockImplementation(async () => ask);
    mockGetWorkflowRun.mockImplementation(async () => left);
  };

  test('an answer is recorded through the API surface and says when it settled the set', async () => {
    withAsk(open);
    mockAnswerItemAsk.mockImplementationOnce(async () => ({
      kind: 'closed',
      ask: answered,
      settled: true,
    }));
    const response = await post('/api/attention/answer', { ref: 'ask:a1', recommended: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ref: 'ask:a1',
      action: 'answer',
      unchanged: false,
      settled: true,
    });
    expect(mockAnswerItemAsk.mock.calls.at(-1)?.[0]).toMatchObject({
      askId: 'a1',
      answer: { decision: 'keep', text: '' },
      via: 'api',
    });
  });

  test('a repeat is unchanged, a different answer is 409, an undeclared option is 400', async () => {
    withAsk(answered);
    mockAnswerItemAsk.mockImplementationOnce(async () => ({ kind: 'unchanged', ask: answered }));
    const repeat = await post('/api/attention/answer', { ref: 'ask:a1', choose: ['keep'] });
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toMatchObject({ unchanged: true });

    mockAnswerItemAsk.mockImplementationOnce(async () => ({ kind: 'refused', ask: answered }));
    expect((await post('/api/attention/answer', { ref: 'ask:a1', choose: ['drop'] })).status).toBe(
      409
    );

    const calls = mockAnswerItemAsk.mock.calls.length;
    expect((await post('/api/attention/answer', { ref: 'ask:a1', choose: ['nope'] })).status).toBe(
      400
    );
    expect(mockAnswerItemAsk.mock.calls.length).toBe(calls);
  });

  test("a withdrawal is 200, an unknown ref is 404, and a paused run's item is 400", async () => {
    withAsk(open);
    mockWithdrawItemAsk.mockImplementationOnce(async () => ({
      kind: 'closed',
      ask: {
        ...open,
        closed: {
          as: 'withdrawn',
          act: { at: '2026-11-16T11:00:00.000Z', via: 'api', by: null, fromRun: null },
        },
      },
      settled: false,
    }));
    const withdrawn = await post('/api/attention/withdraw', { ref: 'ask:a1' });
    expect(withdrawn.status).toBe(200);
    expect(await withdrawn.json()).toEqual({
      ref: 'ask:a1',
      action: 'withdraw',
      unchanged: false,
      settled: false,
    });

    withAsk(null);
    expect((await post('/api/attention/withdraw', { ref: 'ask:missing' })).status).toBe(404);
    expect((await post('/api/attention/withdraw', { ref: `${left.id}:pause-1` })).status).toBe(400);
  });
});
