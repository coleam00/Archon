import { mock, type Mock } from 'bun:test';
import type { IWorkflowStore, WorkflowGateStore } from './store';
import {
  gateProjection,
  pendingGateSchema,
  readGateQueue,
  readSubrunMetadata,
  type GateQueue,
  type GateResponse,
  type WorkflowRun,
} from './schemas/workflow-run';

type GateRun = Pick<WorkflowRun, 'id' | 'parent_run_id' | 'status' | 'metadata'>;

type GateStoreTestMethods = { [K in keyof WorkflowGateStore]: Mock<WorkflowGateStore[K]> } & {
  resolveGate(id: string, response: GateResponse): void;
};

export function createGateStoreTestMethods(
  lookup: (id: string) => GateRun | undefined = () => undefined,
  event: IWorkflowStore['persistWorkflowEvent'] = async () => undefined
): GateStoreTestMethods {
  const fallback = new Map<string, GateRun>();
  const row = (id: string): GateRun => {
    const found = lookup(id) ?? fallback.get(id);
    if (found) return found;
    const fresh: GateRun = { id, parent_run_id: null, status: 'running', metadata: {} };
    fallback.set(id, fresh);
    return fresh;
  };
  const path = (id: string): GateRun[] => {
    const chain: GateRun[] = [];
    let next: string | null = id;
    while (next !== null) {
      const current = row(next);
      chain.unshift(current);
      next = current.parent_run_id;
    }
    return chain;
  };
  const project = (owner: GateRun, queue: GateQueue): void => {
    owner.metadata = { ...owner.metadata, gate_queue: queue };
    for (const gate of [...(queue.active ? [queue.active] : []), ...queue.pending].reverse()) {
      const chain = path(gate.runId);
      for (let i = 0; i < chain.length; i++) {
        const current = chain[i];
        const child = chain[i + 1];
        current.status = 'paused';
        current.metadata = {
          ...current.metadata,
          approval: {
            ...gateProjection(queue, gate, owner.id),
            ...(child
              ? {
                  type: 'child_workflow',
                  nodeId: readSubrunMetadata(child.metadata).parentNodeId,
                  childRunId: child.id,
                }
              : {}),
          },
        };
      }
    }
  };
  return {
    resolveGate: (id: string, response: GateResponse): void => {
      const owner = path(id)[0];
      const queue = readGateQueue(owner.metadata);
      const gate = queue?.active;
      if (!gate || !queue || gate.runId !== id || gate.presentation === 'unclaimed')
        throw new Error('No presented test gate');
      queue.resolved.push({ ...gate, response });
      queue.active = queue.pending.shift() ?? null;
      row(id).metadata.approval = { ...gate.context, gateId: gate.id, resolved: response.resolved };
      project(owner, queue);
    },
    pauseWorkflowRun: mock<IWorkflowStore['pauseWorkflowRun']>(async (id, context, extra) => {
      const chain = path(id);
      const owner = chain[0];
      const current = chain[chain.length - 1];
      const stopped = chain.find(run => run.status !== 'running' && run.status !== 'paused');
      if (stopped)
        return { status: 'externally_stopped', runId: stopped.id, runStatus: stopped.status };
      if (context.type === 'child_workflow') {
        current.status = 'paused';
        if (!readGateQueue(owner.metadata)?.active) current.metadata.approval = context;
        return { status: 'blocked_on_child', ownerId: owner.id };
      }
      const queue =
        readGateQueue(owner.metadata) ??
        ({
          version: 1,
          phase: 'collecting',
          active: null,
          pending: [],
          resolved: [],
        } satisfies GateQueue);
      const gate = {
        id: context.gateId ?? crypto.randomUUID(),
        runId: id,
        context: pendingGateSchema.shape.context.strip().parse(context),
        readyForPresentation: false,
        presentation: 'unclaimed' as const,
      };
      const position = queue.active ? 'queued' : 'active';
      if (queue.active) queue.pending.push(gate);
      else queue.active = gate;
      current.metadata = { ...current.metadata, ...extra };
      project(owner, queue);
      return { status: 'registered', ownerId: owner.id, gateId: gate.id, position };
    }),
    reconcileWorkflowGateChild: mock<IWorkflowStore['reconcileWorkflowGateChild']>(async id => {
      const owner = path(id)[0];
      const child = row(id);
      const queue = readGateQueue(owner.metadata);
      if (
        !['running', 'paused', 'pending'].includes(child.status) &&
        [queue?.active, ...(queue?.pending ?? [])].some(
          gate => gate && path(gate.runId).some(run => run.id === id)
        )
      )
        owner.status = 'failed';
    }),
    getWorkflowGateState: mock<IWorkflowStore['getWorkflowGateState']>(async id => {
      const owner = path(id)[0];
      return { ownerId: owner.id, queue: readGateQueue(owner.metadata) };
    }),
    settleWorkflowGates: mock<IWorkflowStore['settleWorkflowGates']>(async id => {
      const owner = path(id)[0];
      const queue = readGateQueue(owner.metadata);
      if (queue) {
        for (const gate of [...(queue.active ? [queue.active] : []), ...queue.pending]) {
          if (gate.runId === id) gate.readyForPresentation = true;
        }
        if (owner.id === id) queue.phase = 'parked';
        project(owner, queue);
      }
      return owner.id;
    }),
    claimWorkflowGatePresentation: mock<IWorkflowStore['claimWorkflowGatePresentation']>(
      async id => {
        const owner = path(id)[0];
        const queue = readGateQueue(owner.metadata);
        const gate = queue?.active;
        if (
          owner.status !== 'paused' ||
          queue?.phase !== 'parked' ||
          !gate?.readyForPresentation ||
          gate.presentation !== 'unclaimed'
        )
          return null;
        gate.presentation = 'claimed';
        await event({
          workflow_run_id: gate.runId,
          event_type: 'approval_requested',
          step_name: gate.context.execution?.path ?? gate.context.nodeId,
          data: {
            gate_id: gate.id,
            message: gate.context.message,
            iteration: gate.context.iteration,
            completionSignaled: gate.context.completionSignaled,
          },
        });
        project(owner, queue);
        return gate;
      }
    ),
    confirmWorkflowGatePresentation: mock<IWorkflowStore['confirmWorkflowGatePresentation']>(
      async (id, gateId) => {
        const owner = path(id)[0];
        const queue = readGateQueue(owner.metadata);
        const gate = [queue?.active, ...(queue?.resolved ?? [])].find(gate => gate?.id === gateId);
        if (gate && queue) {
          gate.presentation = 'delivered';
          project(owner, queue);
        }
        return { active: queue?.active?.id === gateId };
      }
    ),
    failWorkflowGatePresentation: mock<IWorkflowStore['failWorkflowGatePresentation']>(
      async (id, gateId, error) => {
        const owner = path(id)[0];
        const gate = readGateQueue(owner.metadata)?.active;
        if (gate?.id !== gateId) return { failed: false };
        owner.status = 'failed';
        owner.metadata.error = error;
        row(gate.runId).status = 'failed';
        return { failed: true };
      }
    ),
    consumeWorkflowGateContinuation: mock<IWorkflowStore['consumeWorkflowGateContinuation']>(
      async (id, gateId) => {
        const owner = path(id)[0];
        const queue = readGateQueue(owner.metadata);
        if (queue) {
          queue.resolved = queue.resolved.filter(gate => gate.id !== gateId);
          owner.metadata.gate_queue = queue;
        }
      }
    ),
  };
}
