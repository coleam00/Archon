import { expect } from 'bun:test';
import type { IWorkflowStore } from '../store';
import { approval, eight, create, running, types, gateEvents } from './fixtures';

export async function assertWorkflowClaimRace(
  store: Pick<
    IWorkflowStore,
    'createWorkflowRun' | 'claimPendingWorkflowRun' | 'getWorkflowRun' | 'listWorkflowEvents'
  >
): Promise<void> {
  const run = await create(store);
  const results = await eight(() => store.claimPendingWorkflowRun(run.id, '/checkout'));
  expect(results.filter(result => result !== null)).toHaveLength(1);
  expect(results.filter(result => result === null)).toHaveLength(7);
  expect(await store.getWorkflowRun(run.id)).toMatchObject({
    status: 'running',
    working_path: '/checkout',
  });
  expect(await store.claimPendingWorkflowRun(run.id)).toBeNull();
  expect(await types(store, run.id)).toEqual([]);
}

export async function assertWorkflowGateRace(
  store: Pick<
    IWorkflowStore,
    | 'createWorkflowRun'
    | 'claimPendingWorkflowRun'
    | 'getWorkflowRun'
    | 'listWorkflowEvents'
    | 'pauseWorkflowRun'
    | 'resolveApprovalGate'
  >
): Promise<void> {
  const run = await running(store);
  await store.pauseWorkflowRun(run.id, approval);
  const results = await eight(index =>
    store.resolveApprovalGate(
      run.id,
      {
        approval: { ...approval, resolved: 'approved' },
        winner: index,
      },
      gateEvents(index),
      { nodeId: approval.nodeId, pauseId: 'first' }
    )
  );
  expect(results.filter(result => result.resolved)).toHaveLength(1);
  expect(results.filter(result => !result.resolved)).toHaveLength(7);
  const winner = results.findIndex(result => result.resolved);
  expect(await store.getWorkflowRun(run.id)).toMatchObject({
    status: 'paused',
    metadata: { winner },
  });
  const rows = await store.listWorkflowEvents(run.id);
  expect(rows.map(event => event.event_type)).toEqual(['approval_received', 'node_completed']);
  expect(rows[0]?.data).toEqual({ winner });
  expect(rows[1]?.data).toEqual({ node_output: String(winner) });
}

export async function assertWorkflowEventFeedRace(
  store: Pick<
    IWorkflowStore,
    | 'createWorkflowRun'
    | 'createWorkflowEvent'
    | 'listWorkflowEvents'
    | 'getWorkflowEventHead'
    | 'readWorkflowEventsAfter'
  >
): Promise<void> {
  const run = await create(store);
  let cursor = await store.getWorkflowEventHead();
  const seen: string[] = [];
  let finished = false;
  const writes = eight(index =>
    store.createWorkflowEvent({
      workflow_run_id: run.id,
      event_type: 'workflow_started',
      data: { index },
    })
  ).finally(() => {
    finished = true;
  });
  do {
    const page = await store.readWorkflowEventsAfter(cursor, { limit: 1 });
    seen.push(...page.events.map(({ event }) => event.id));
    cursor = page.next;
    await new Promise(resolve => setTimeout(resolve, 0));
  } while (!finished);
  await writes;
  for (;;) {
    const page = await store.readWorkflowEventsAfter(cursor, { limit: 1 });
    if (page.next === cursor) break;
    seen.push(...page.events.map(({ event }) => event.id));
    cursor = page.next;
  }
  const committed = await store.listWorkflowEvents(run.id);
  expect(committed).toHaveLength(8);
  expect(seen.sort()).toEqual(committed.map(event => event.id).sort());
}
