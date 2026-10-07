import { expect, test } from 'bun:test';
import type { WorkflowRun } from './schemas/workflow-run';
import type { WorkflowEventRow } from './schemas/workflow-event';
import type { IWorkflowStore } from './store';
import { assertWorkflowClaimRace, assertWorkflowGateRace } from './store-conformance';

type RaceStore = Pick<
  IWorkflowStore,
  | 'createWorkflowRun'
  | 'getWorkflowRun'
  | 'claimPendingWorkflowRun'
  | 'pauseWorkflowRun'
  | 'resolveApprovalGate'
  | 'updateWorkflowRun'
  | 'persistWorkflowEvent'
  | 'listWorkflowEvents'
>;

function makeRaceStore(): RaceStore {
  let run: WorkflowRun;
  const events: WorkflowEventRow[] = [];
  const store: RaceStore = {
    createWorkflowRun: async input => {
      run = {
        id: crypto.randomUUID(),
        workflow_name: input.workflow_name,
        user_message: input.user_message,
        status: 'pending',
        metadata: {},
        origin: null,
        conversation_id: null,
        parent_conversation_id: null,
        codebase_id: null,
        user_id: null,
        outcome: null,
        parent_run_id: null,
        adopted_from_run_id: null,
        started_at: new Date(),
        last_activity_at: null,
        completed_at: null,
        working_path: null,
        output_root: null,
        checkout_baseline: null,
      };
      return structuredClone(run);
    },
    getWorkflowRun: async () => structuredClone(run),
    claimPendingWorkflowRun: async (_id, path) => {
      if (run.status !== 'pending') return null;
      run.status = 'running';
      run.working_path = path ?? null;
      return structuredClone(run);
    },
    pauseWorkflowRun: async (_id, approval) => {
      run.status = 'paused';
      run.metadata.approval = structuredClone(approval);
    },
    resolveApprovalGate: async (_id, metadata, rows) => {
      const approval = run.metadata.approval;
      if (
        run.status !== 'paused' ||
        typeof approval !== 'object' ||
        approval === null ||
        ('resolved' in approval && approval.resolved != null)
      )
        return { resolved: false };
      Object.assign(run.metadata, structuredClone(metadata));
      for (const row of rows) await store.persistWorkflowEvent({ ...row, workflow_run_id: run.id });
      return { resolved: true };
    },
    updateWorkflowRun: async (_id, patch) => {
      Object.assign(run, structuredClone(patch));
    },
    persistWorkflowEvent: async input => {
      events.push({
        ...input,
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        step_index: input.step_index ?? null,
        step_name: input.step_name ?? null,
        data: input.data ?? {},
      });
    },
    listWorkflowEvents: async () => structuredClone(events),
  };
  return store;
}

function breakCas(store: RaceStore): RaceStore {
  return {
    ...store,
    claimPendingWorkflowRun: async (id, path) => {
      const prior = await store.getWorkflowRun(id);
      if (prior?.status !== 'pending') return null;
      await store.updateWorkflowRun(id, { status: 'running', working_path: path });
      return store.getWorkflowRun(id);
    },
    resolveApprovalGate: async (id, metadata, events) => {
      const prior = await store.getWorkflowRun(id);
      const approval = prior?.metadata.approval;
      if (
        prior?.status !== 'paused' ||
        typeof approval !== 'object' ||
        approval === null ||
        ('resolved' in approval && approval.resolved != null)
      )
        return { resolved: false };
      await store.updateWorkflowRun(id, { metadata });
      for (const event of events)
        await store.persistWorkflowEvent({ ...event, workflow_run_id: id });
      return { resolved: true };
    },
  };
}

test('claim probe passes atomic CAS and rejects read-then-write through the public port', async () => {
  await assertWorkflowClaimRace(makeRaceStore());
  await expect(assertWorkflowClaimRace(breakCas(makeRaceStore()))).rejects.toThrow();
});
test('gate probe passes atomic CAS and rejects read-then-write through the public port', async () => {
  await assertWorkflowGateRace(makeRaceStore());
  await expect(assertWorkflowGateRace(breakCas(makeRaceStore()))).rejects.toThrow();
});
