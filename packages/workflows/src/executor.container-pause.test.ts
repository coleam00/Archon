// @archon-test-isolated
import { describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  createMockDeps,
  createMockPlatform,
  deliveredMessages,
  mockLogFn,
  mockSendQueryDag,
  setMockArtifactHome,
  stubMissingContainer,
} from './dag/test-utils';
import { createFileWorkflowStore } from './file-store/store';
import { executeWorkflow } from './executor';
import { hydrateResumableRun } from './run-resume';
import { finishNodeExecution } from './node-execution';
import { serializeNodeStateRecord } from './node-record-serialization';
import { resolveWorkflow } from './graph-plan';
import { workflowDefinitionSchema, type WorkflowRun, type ResolvedWorkflow } from './schemas';
import { approvalContextSchema } from './schemas/workflow-run';
import { executionClaim, type IWorkflowStore, type PersistedNodeOutput } from './store';
import type { ContainerWriteBackBackend } from './container-context';
import { getWorkflowEventEmitter, type WorkflowEmitterEvent } from './event-emitter';

import * as untilBash from './dag/nodes/loop-group/until-bash';

const roots = trackTempRoots();
const approval = { nodeId: 'review', type: 'approval' as const, message: 'Review' };
const summary = {
  added: ['x'],
  modified: [],
  deleted: [],
  symlinks: [],
  skipped: [],
  totalCount: 1,
  truncated: false,
};
const paths = ['ordinary', 'writeback', 'unresolved'] as const;
type PausePath = (typeof paths)[number];

async function setup(
  path: PausePath,
  ordinaryNodes?: unknown[],
  options?: Pick<ResolvedWorkflow, 'returns' | 'outcome_field' | 'budget'>
) {
  const root = roots(await mkdtemp(join(tmpdir(), 'container-pause-')));
  setMockArtifactHome(root);
  const store = await createFileWorkflowStore({ root: join(root, 'store') });
  let run = await store.createWorkflowRun({
    workflow_name: 'pause',
    user_message: '',
    working_path: root,
    metadata: { isolation: 'container', isolation_env_id: 'env' },
  });
  await store.updateWorkflowRun(run.id, { output_root: join(root, 'output') });
  const claimed = await store.claimPendingWorkflowRun(run.id);
  if (!claimed) throw new Error('not claimed');
  run = claimed;
  if (path === 'unresolved') {
    await store.pauseWorkflowRun(
      run.id,
      { ...approval, nodeId: '__writeback__', type: 'writeback' },
      {
        pending_writeback: { envId: 'env', summary },
      }
    );
    run = await store.resumeWorkflowRun(run.id);
  }
  const stop = mock(async () => undefined);
  const backend = {
    suspend: mock(async () => undefined),
    prepareSuspend: mock(async () => stop),
    finalize: mock(async () => ({ requiresApproval: true, changeSummary: summary })),
    applyChanges: mock(async () => ({ filesApplied: 1, filesDeleted: 0, warnings: [] })),
    discardChanges: mock(async () => undefined),
  } satisfies ContainerWriteBackBackend;
  const platform = createMockPlatform();
  const workflow = resolveWorkflow(
    workflowDefinitionSchema.parse({
      name: 'pause',
      description: 'Pause fixture',
      ...options,
      nodes:
        path === 'ordinary'
          ? (ordinaryNodes ?? [{ id: 'review', approval: { message: 'Review' } }])
          : [{ id: 'work', bash: 'echo done' }],
    })
  );
  const live: WorkflowEmitterEvent[] = [];
  const unsubscribe = getWorkflowEventEmitter().subscribe(event => {
    if (event.runId === run.id) live.push(event);
  });
  const pendingEvents: Promise<void>[] = [];
  const createWorkflowEvent: IWorkflowStore['createWorkflowEvent'] = input => {
    const pending = store.createWorkflowEvent(input);
    pendingEvents.push(pending);
    return pending;
  };
  const execute = async (
    overrides: Partial<IWorkflowStore> = {},
    executionRun = run,
    priorCompletedNodes = new Map<string, PersistedNodeOutput>(
      path === 'ordinary' ? [] : [['work', { output: 'done' }]]
    )
  ) => {
    const result = await executeWorkflow(
      createMockDeps({ ...store, createWorkflowEvent, ...overrides }),
      platform,
      'conv',
      root,
      workflow,
      '',
      undefined,
      {
        preCreatedRun: executionRun,
        priorCompletedNodes,
        execContext: { kind: 'container', containerId: 'cid' },
        container: { envId: 'env', writeBack: 'approve', backend },
        resolvedBaseBranch: 'main',
      }
    );
    await Promise.all(pendingEvents);
    return result;
  };
  return { root, store, run, backend, stop, platform, live, unsubscribe, execute };
}

function stopped(live: WorkflowEmitterEvent[]) {
  return live.filter(event => event.type === 'container_lifecycle' && event.phase === 'stopped');
}

describe('container pause segment ownership through the executor', () => {
  it('budget refusal alongside a published pause remains an execution failure', async () => {
    const transport = stubMissingContainer();
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'result', cost: 0.25, sessionId: 'budget-work' };
    });
    const f = await setup(
      'ordinary',
      [
        { id: 'work', prompt: 'Work' },
        { id: 'refused', prompt: 'Cannot start' },
        { id: 'review', approval: { message: 'Review' } },
      ],
      { budget: { max_work_units: 1 } }
    );
    try {
      expect(await f.execute()).toMatchObject({
        success: false,
        error: expect.stringContaining('work_units_exhausted'),
      });
      const row = await f.store.getWorkflowRun(f.run.id);
      expect(row?.status).toBe('paused');
      expect(row?.metadata.approval).toMatchObject({ nodeId: 'review' });
      expect(row?.metadata.total_cost_usd).toBe(0.25);
      expect(f.stop).toHaveBeenCalledTimes(1);
      expect(
        (await f.store.listWorkflowEvents(f.run.id)).some(e => e.event_type === 'workflow_failed')
      ).toBe(false);
    } finally {
      f.unsubscribe();
      transport.mockRestore();
    }
  });

  it.each(['after-layer', 'usage', 'unwind'] as const)(
    'successor accounting survives old %s bookkeeping',
    async mode => {
      const transport = stubMissingContainer();
      mockSendQueryDag.mockImplementation(async function* () {
        yield {
          type: 'result',
          cost: 0.25,
          sessionId: 'old-work',
          structuredOutput: { green: true },
          tokens: { input: 100, output: 10 },
        };
      });
      const f = await setup(
        'ordinary',
        [
          {
            id: 'verdict',
            prompt: 'Verdict',
            output_format: {
              type: 'object',
              properties: { green: { type: 'boolean' } },
              required: ['green'],
            },
          },
          { id: 'review', approval: { message: 'Review' } },
        ],
        mode === 'usage' ? undefined : { returns: 'verdict', outcome_field: 'green' }
      );
      let published = false;
      let advanced = false;
      let unwinding = false;
      const advance = async () => {
        await f.store.resumeWorkflowRun(f.run.id);
        await f.store.updateWorkflowRun(f.run.id, {
          outcome: 'failed',
          metadata: {
            total_cost_usd: 9,
            total_tokens_in: 900,
            total_tokens_out: 90,
          },
        });
        advanced = true;
      };
      try {
        const result = await f.execute({
          pauseWorkflowRun: async (...args) => {
            await f.store.pauseWorkflowRun(...args);
            published = true;
          },
          updateWorkflowRun: async (id, updates, claim) => {
            if (mode === 'unwind' && published && !unwinding && updates.outcome !== undefined) {
              unwinding = true;
              throw new Error('outcome unavailable');
            }
            if (
              published &&
              !advanced &&
              (updates.outcome !== undefined || updates.metadata?.total_cost_usd !== undefined)
            )
              await advance();
            await f.store.updateWorkflowRun(id, updates, claim);
          },
        });
        expect(advanced).toBe(true);
        expect(result).toMatchObject(
          mode === 'unwind'
            ? { success: false, error: 'outcome unavailable' }
            : { success: true, paused: true }
        );
        const row = await f.store.getWorkflowRun(f.run.id);
        expect(row?.outcome).toBe('failed');
        expect(row?.metadata).toMatchObject({
          total_cost_usd: 9,
          total_tokens_in: 900,
          total_tokens_out: 90,
        });
        expect(row?.status).toBe('running');
        expect(f.stop).not.toHaveBeenCalled();
      } finally {
        f.unsubscribe();
        transport.mockRestore();
      }
    }
  );

  it.each(['approved', 'rejected'] as const)(
    'normal write-back pause resumes after %s',
    async decision => {
      const f = await setup('writeback');
      try {
        expect(await f.execute()).toMatchObject({ success: true, paused: true });
        expect(f.stop).toHaveBeenCalledTimes(1);
        const paused = await f.store.getWorkflowRun(f.run.id);
        const approval = approvalContextSchema.parse(paused?.metadata.approval);
        expect(
          await f.store.resolveApprovalGate(
            f.run.id,
            {
              approval: { ...approval, resolved: decision },
            },
            []
          )
        ).toEqual({ resolved: true });
        const resumed = await f.store.resumeWorkflowRun(f.run.id);
        expect(await f.execute({}, resumed)).toMatchObject({ success: true });
        expect((await f.store.getWorkflowRun(f.run.id))?.status).toBe('completed');
        expect(f.backend.applyChanges).toHaveBeenCalledTimes(decision === 'approved' ? 1 : 0);
        expect(f.backend.discardChanges).toHaveBeenCalledTimes(decision === 'rejected' ? 1 : 0);
        expect(f.stop).toHaveBeenCalledTimes(1);
      } finally {
        f.unsubscribe();
      }
    }
  );
  for (const leaf of [
    { approval: { message: 'Deferred approval' } },
    { wait: { duration_ms: 3_600_000 } },
    { wait: { until: '2099-01-01T00:00:00Z' } },
    { wait: { event: 'signal', deadline_ms: 3_600_000 } },
    { wait: { attention: 'Deferred attention' } },
    {
      loop: {
        prompt: 'Review',
        until: 'COMPLETE',
        interactive: true,
        gate_message: 'Feedback?',
        max_iterations: 2,
      },
    },
    {
      loop: {
        command: 'review',
        until: 'COMPLETE',
        interactive: true,
        gate_message: 'Feedback?',
        max_iterations: 2,
      },
    },
  ]) {
    for (const nested of [false, true]) {
      it.each(['failed', 'cancelled'] as const)(
        `terminal %s wins ${JSON.stringify(leaf)} pause (nested=${nested}) without suspension`,
        async status => {
          const node = { id: 'deferred', ...leaf };
          const f = await setup('ordinary', [
            nested
              ? {
                  id: 'group',
                  loop_group: { max_iterations: 2, until_bash: 'true', nodes: [node] },
                }
              : node,
          ]);
          await mkdir(join(f.root, '.archon', 'commands'), { recursive: true });
          await writeFile(join(f.root, '.archon', 'commands', 'review.md'), 'Review');
          const terminate = async () => {
            if (status === 'failed') await f.store.failWorkflowRun(f.run.id, 'External failure');
            else await f.store.cancelWorkflowRun(f.run.id);
          };
          try {
            await f.execute({
              pauseWorkflowRun: async (...args) => {
                await terminate();
                await f.store.pauseWorkflowRun(...args);
              },
              pauseWorkflowRunForWait: async (...args) => {
                await terminate();
                await f.store.pauseWorkflowRunForWait(...args);
              },
            });
            expect((await f.store.getWorkflowRun(f.run.id))?.status).toBe(status);
            expect(
              (await f.store.listWorkflowEvents(f.run.id)).filter(
                event => event.event_type === 'node_suspended'
              )
            ).toEqual([]);
            expect(f.stop).not.toHaveBeenCalled();
          } finally {
            f.unsubscribe();
          }
        }
      );
      it.each(['none', 'suspension', 'both'] as const)(
        `deferred ${JSON.stringify(leaf)} (nested=${nested}, rejected write=%s) resumes only after settlement`,
        async writeFailure => {
          const rejectWrite = writeFailure !== 'none';
          const sibling = nested
            ? {
                id: 'group',
                loop_group: {
                  max_iterations: 2,
                  until_bash: 'true',
                  nodes: [{ id: 'deferred', ...leaf }],
                },
              }
            : { id: 'deferred', ...leaf };
          mockSendQueryDag.mockImplementation(async function* () {
            yield { type: 'agent_message_chunk', text: 'Review' };
            yield {
              type: 'result',
              sessionId: 'verdict-session',
              structuredOutput: { green: true },
            };
          });
          const f = await setup(
            'ordinary',
            [
              { id: 'review', approval: { message: 'First' } },
              sibling,
              {
                id: 'verdict',
                prompt: 'Return a verdict',
                output_format: {
                  type: 'object',
                  properties: { green: { type: 'boolean' } },
                  required: ['green'],
                },
              },
            ],
            { returns: 'verdict', outcome_field: 'green' }
          );
          await mkdir(join(f.root, '.archon', 'commands'), { recursive: true });
          await writeFile(join(f.root, '.archon', 'commands', 'review.md'), 'Review');
          const published = Promise.withResolvers<void>();
          const attempted = Promise.withResolvers<void>();
          try {
            const result = await f.execute({
              updateWorkflowRun: async (id, updates, claim) => {
                if (writeFailure === 'both' && updates.outcome !== undefined) {
                  throw new Error('Secondary outcome write rejected');
                }
                await f.store.updateWorkflowRun(id, updates, claim);
              },
              persistWorkflowEvent: async event => {
                if (
                  rejectWrite &&
                  event.event_type === 'node_suspended' &&
                  event.step_name?.endsWith('deferred')
                )
                  throw new Error('Deferred suspension write rejected');
                await f.store.persistWorkflowEvent(event);
              },
              pauseWorkflowRun: async (...args) => {
                if (args[1].nodeId === 'review') {
                  await attempted.promise;
                  await f.store.pauseWorkflowRun(...args);
                  published.resolve();
                } else {
                  attempted.resolve();
                  await published.promise;
                  await f.store.pauseWorkflowRun(...args);
                }
              },
              pauseWorkflowRunForWait: async (...args) => {
                attempted.resolve();
                await published.promise;
                await f.store.pauseWorkflowRunForWait(...args);
              },
            });
            expect(result).toMatchObject(
              rejectWrite
                ? {
                    success: false,
                    error: expect.stringContaining('Deferred suspension write rejected'),
                  }
                : { success: true, paused: true }
            );
            const paused = await f.store.getWorkflowRun(f.run.id);
            if (!paused) throw new Error('Missing pause');
            expect(paused.outcome).toBe(writeFailure === 'both' ? null : 'succeeded');
            if (writeFailure === 'both') {
              expect(mockLogFn).toHaveBeenCalledWith(
                expect.objectContaining({
                  err: expect.objectContaining({ message: 'Secondary outcome write rejected' }),
                }),
                'dag.authored_outcome_persist_failed_during_unwind'
              );
            }
            expect(
              (await f.store.listWorkflowEvents(f.run.id)).some(
                event => event.step_name === 'verdict' && event.event_type === 'node_completed'
              )
            ).toBe(true);
            const active = approvalContextSchema.parse(paused.metadata.approval);
            if (!active.execution) throw new Error('Missing gate execution');
            const completion = serializeNodeStateRecord(
              finishNodeExecution(
                active.execution,
                { status: 'completed' },
                { output: { text: '' } }
              )
            );
            expect(
              await f.store.resolveApprovalGate(
                f.run.id,
                { approval: { ...active, resolved: 'approved' } },
                [completion]
              )
            ).toEqual({ resolved: true });
            const resolved = await f.store.getWorkflowRun(f.run.id);
            if (!resolved) throw new Error('Missing resolved pause');
            if (rejectWrite) {
              await expect(hydrateResumableRun({ store: f.store }, resolved)).rejects.toThrow(
                'no durable completion or suspension record'
              );
              expect((await f.store.getWorkflowRun(f.run.id))?.status).toBe('paused');
            } else {
              const hydrated = await hydrateResumableRun({ store: f.store }, resolved);
              if (!hydrated) throw new Error('Missing hydrated run');
              expect(
                await f.execute({}, hydrated.preCreatedRun, hydrated.priorCompletedNodes)
              ).toMatchObject({ success: true, paused: true });
              const next = await f.store.getWorkflowRun(f.run.id);
              expect(next?.status).toBe('paused');
              expect(next?.metadata.approval ?? next?.metadata.wait).toMatchObject({
                nodeId: nested && !('loop' in leaf) ? 'group' : 'deferred',
              });
            }
            const events = await f.store.listWorkflowEvents(f.run.id);
            expect(
              events.some(
                event =>
                  event.step_name === (nested ? 'group.deferred' : 'deferred') &&
                  event.event_type === 'node_suspended'
              )
            ).toBe(!rejectWrite);
          } finally {
            published.resolve();
            f.unsubscribe();
          }
        }
      );
    }
  }

  for (const suspension of [
    { approval: { message: 'Review' } },
    { wait: { duration_ms: 3_600_000 } },
  ]) {
    for (const nested of [false, true]) {
      it.each([false, true])(
        `ordinary ${'approval' in suspension ? 'gate' : 'wait'} (nested=${nested}, resume=%s) retains publication`,
        async resume => {
          const leaf = { id: 'review', ...suspension };
          const group = (id: string, nodes: unknown[]) => ({
            id,
            loop_group: { max_iterations: 2, until_bash: 'echo MUST_NOT_RUN', nodes },
          });
          const pauseNode = nested ? group('outer', [group('inner', [leaf])]) : leaf;
          const f = await setup('ordinary', [
            pauseNode,
            { id: 'after', bash: 'echo MUST_NOT_RUN', depends_on: [pauseNode.id] },
          ]);
          const completion = spyOn(untilBash, 'runGroupUntilBash');
          let published = false;
          let successor: WorkflowRun | undefined;
          const publishedPause = async () => {
            published = true;
            if (resume) successor = await f.store.resumeWorkflowRun(f.run.id);
          };
          try {
            const result = await f.execute({
              pauseWorkflowRun: async (...args) => {
                await f.store.pauseWorkflowRun(...args);
                await publishedPause();
              },
              pauseWorkflowRunForWait: async (...args) => {
                await f.store.pauseWorkflowRunForWait(...args);
                await publishedPause();
              },
            });
            expect(published).toBe(true);
            expect(result).toMatchObject({ success: true, paused: true });
            const row = await f.store.getWorkflowRun(f.run.id);
            expect(row?.status).toBe(resume ? 'running' : 'paused');
            expect(executionClaim(row?.metadata ?? {})).toBe(
              executionClaim((successor ?? f.run).metadata)
            );
            expect(f.stop).toHaveBeenCalledTimes(resume ? 0 : 1);
            const events = await f.store.listWorkflowEvents(f.run.id);
            expect(
              events.some(e =>
                ['workflow_failed', 'workflow_completed', 'loop_iteration_completed'].includes(
                  e.event_type
                )
              )
            ).toBe(false);
            expect(events.some(e => e.step_name === 'after')).toBe(false);
            if (nested) {
              expect(events.filter(e => e.event_type === 'loop_iteration_started')).toHaveLength(2);
              expect(completion).not.toHaveBeenCalled();
            }
            if (!resume && row) {
              expect((await hydrateResumableRun({ store: f.store }, row)) === null).toBe(
                'approval' in suspension
              );
            }
          } finally {
            completion.mockRestore();
            f.unsubscribe();
          }
        }
      );
    }
  }

  for (const suspension of [
    { approval: { message: 'Review' } },
    { wait: { duration_ms: 3_600_000 } },
  ]) {
    it.each([false, true])(
      `post-publication ${'approval' in suspension ? 'gate' : 'wait'} outcome hook failure (resume=%s) preserves the segment`,
      async resume => {
        const transport = stubMissingContainer();
        mockSendQueryDag.mockImplementation(async function* () {
          yield {
            type: 'result',
            sessionId: 'verdict-session',
            structuredOutput: { green: true },
            cost: 0.25,
            tokens: { input: 100, output: 10 },
          };
        });
        const error = new Error('outcome write unavailable after pause');
        const f = await setup(
          'ordinary',
          [
            {
              id: 'verdict',
              prompt: 'Return a verdict',
              output_format: {
                type: 'object',
                properties: { green: { type: 'boolean' } },
                required: ['green'],
              },
            },
            { id: 'review', ...suspension },
            { id: 'after', bash: 'echo MUST_NOT_RUN', depends_on: ['review', 'verdict'] },
          ],
          { returns: 'verdict', outcome_field: 'green' }
        );
        let published = false;
        let successor: WorkflowRun | undefined;
        const afterPublication = async () => {
          published = true;
          if (resume) successor = await f.store.resumeWorkflowRun(f.run.id);
        };
        try {
          const result = await f.execute({
            updateWorkflowRun: async (id, updates, claim) => {
              if (updates.outcome !== undefined) {
                expect(published).toBe(true);
                throw error;
              }
              await f.store.updateWorkflowRun(id, updates, claim);
            },
            pauseWorkflowRun: async (...args) => {
              await f.store.pauseWorkflowRun(...args);
              await afterPublication();
            },
            pauseWorkflowRunForWait: async (...args) => {
              await f.store.pauseWorkflowRunForWait(...args);
              await afterPublication();
            },
          });
          expect(published).toBe(true);
          const row = await f.store.getWorkflowRun(f.run.id);
          if (resume) expect(row?.metadata.total_cost_usd).toBeUndefined();
          else
            expect(row?.metadata).toMatchObject({
              total_cost_usd: 0.25,
              total_tokens_in: 100,
              total_tokens_out: 10,
            });
          expect(await f.store.getDagResumeSnapshot(f.run.id)).toMatchObject({
            costUsd: 0.25,
            tokens: { input: 100, output: 10 },
          });
          expect(row?.status).toBe(resume ? 'running' : 'paused');
          expect(executionClaim(row?.metadata ?? {})).toBe(
            executionClaim((successor ?? f.run).metadata)
          );
          expect(result).toMatchObject({
            success: false,
            error: error.message,
          });
          expect(row?.outcome).toBeNull();
          expect(f.stop).toHaveBeenCalledTimes(resume ? 0 : 1);
          expect(
            mockLogFn.mock.calls.some(
              ([data, site]) =>
                site === 'dag.execution_error_after_pause' &&
                typeof data === 'object' &&
                data !== null &&
                'err' in data &&
                data.err instanceof Error &&
                data.err === error
            )
          ).toBe(true);
          const events = await f.store.listWorkflowEvents(f.run.id);
          expect(
            events.some(event =>
              ['workflow_failed', 'workflow_completed'].includes(event.event_type)
            )
          ).toBe(false);
          expect(events.some(event => event.step_name === 'after')).toBe(false);
        } finally {
          transport.mockRestore();
          mockSendQueryDag.mockImplementation(async function* () {
            yield { type: 'agent_message_chunk', text: 'DAG AI response' };
            yield { type: 'result', sessionId: 'dag-session-id' };
          });
          f.unsubscribe();
        }
      }
    );
  }

  for (const nested of [false, true]) {
    it.each([false, true])(
      `post-publication wait event failure (nested=${nested}, resume=%s) preserves the segment`,
      async resume => {
        const transport = stubMissingContainer();
        mockSendQueryDag.mockImplementation(async function* () {
          yield { type: 'agent_message_chunk', text: 'Paid work' };
          yield {
            type: 'result',
            sessionId: 'paid-session',
            cost: 0.25,
            tokens: { input: 100, output: 10 },
          };
        });
        const paid = { id: 'paid', prompt: 'Paid work' };
        const leaf = { id: 'review', depends_on: ['paid'], wait: { duration_ms: 3_600_000 } };
        const pauseNode = nested
          ? {
              id: 'group',
              loop_group: {
                max_iterations: 2,
                until_bash: 'echo MUST_NOT_RUN',
                nodes: [paid, leaf],
              },
            }
          : leaf;
        const f = await setup('ordinary', [
          ...(nested ? [] : [paid]),
          pauseNode,
          { id: 'after', bash: 'echo MUST_NOT_RUN', depends_on: [pauseNode.id] },
        ]);
        const error = new Error('node_suspended write rejected after pause');
        let successor: WorkflowRun | undefined;
        let rejected = false;
        try {
          const result = await f.execute({
            pauseWorkflowRunForWait: async (...args) => {
              await f.store.pauseWorkflowRunForWait(...args);
              if (resume) successor = await f.store.resumeWorkflowRun(f.run.id);
            },
            persistWorkflowEvent: async event => {
              if (event.event_type === 'node_suspended') {
                rejected = true;
                throw error;
              }
              await f.store.persistWorkflowEvent(event);
            },
          });
          expect(rejected).toBe(true);
          const row = await f.store.getWorkflowRun(f.run.id);
          expect(row?.status).toBe(resume ? 'running' : 'paused');
          expect(executionClaim(row?.metadata ?? {})).toBe(
            executionClaim((successor ?? f.run).metadata)
          );
          expect(result).toMatchObject({
            success: false,
            error: expect.stringContaining('node_suspended'),
          });
          if (resume) expect(row?.metadata.total_cost_usd).toBeUndefined();
          else
            expect(row?.metadata).toMatchObject({
              total_cost_usd: 0.25,
              total_tokens_in: 100,
              total_tokens_out: 10,
            });
          expect(await f.store.getDagResumeSnapshot(f.run.id)).toMatchObject({
            costUsd: 0.25,
            tokens: { input: 100, output: 10 },
          });
          if (!resume && row) {
            await expect(hydrateResumableRun({ store: f.store }, row)).rejects.toThrow(
              'no durable completion or suspension record'
            );
            expect((await f.store.getWorkflowRun(f.run.id))?.status).toBe('paused');
          }
          expect(f.stop).toHaveBeenCalledTimes(resume ? 0 : 1);
          const events = await f.store.listWorkflowEvents(f.run.id);
          expect(
            events.some(event =>
              ['workflow_failed', 'workflow_completed', 'loop_iteration_completed'].includes(
                event.event_type
              )
            )
          ).toBe(false);
          expect(events.some(event => event.step_name === 'after')).toBe(false);
          expect(events.filter(event => event.event_type === 'node_suspended')).toHaveLength(0);
          expect(
            events.filter(
              event => event.event_type === 'node_completed' && event.step_name?.endsWith('paid')
            )
          ).toHaveLength(1);
          expect(
            mockLogFn.mock.calls.some(
              ([data]) =>
                typeof data === 'object' &&
                data !== null &&
                'err' in data &&
                data.err instanceof Error &&
                data.err.cause === error
            )
          ).toBe(true);
        } finally {
          transport.mockRestore();
          mockSendQueryDag.mockImplementation(async function* () {
            yield { type: 'result', sessionId: 'dag-session-id' };
          });
          f.unsubscribe();
        }
      }
    );
  }

  for (const nested of [false, true]) {
    it.each([{ approval: { message: 'Review' } }, { wait: { duration_ms: 3_600_000 } }])(
      `missing sibling completion (nested=${nested}) refuses resume: %j`,
      async suspension => {
        const transport = stubMissingContainer();
        transport.mockImplementation(async () => ({ stdout: 'done', stderr: '' }));
        const body = [
          { id: 'work', bash: 'echo side-effect' },
          { id: 'review', ...suspension },
        ];
        const f = await setup(
          'ordinary',
          nested
            ? [
                body[0],
                {
                  id: 'group',
                  loop_group: {
                    max_iterations: 2,
                    until_bash: 'echo MUST_NOT_RUN',
                    nodes: [body[1]],
                  },
                },
              ]
            : body
        );
        let publish!: () => void;
        const published = new Promise<void>(resolve => {
          publish = resolve;
        });
        try {
          const result = await f.execute({
            pauseWorkflowRun: async (...args) => {
              await f.store.pauseWorkflowRun(...args);
              publish();
            },
            pauseWorkflowRunForWait: async (...args) => {
              await f.store.pauseWorkflowRunForWait(...args);
              publish();
            },
            persistWorkflowEvent: async event => {
              if (event.event_type === 'node_completed' && event.step_name?.endsWith('work')) {
                await published;
                throw new Error('completion write unavailable');
              }
              await f.store.persistWorkflowEvent(event);
            },
          });
          expect(result).toMatchObject({
            success: false,
            error: expect.stringContaining('node_completed'),
          });
          expect(f.stop).toHaveBeenCalledTimes(1);
          const row = await f.store.getWorkflowRun(f.run.id);
          if (!row) throw new Error('missing run');
          await expect(hydrateResumableRun({ store: f.store }, row)).rejects.toThrow(
            'no durable completion or suspension record'
          );
          expect(executionClaim((await f.store.getWorkflowRun(f.run.id))?.metadata ?? {})).toBe(
            executionClaim(f.run.metadata)
          );
          const events = await f.store.listWorkflowEvents(f.run.id);
          expect(
            events.filter(
              event => event.event_type === 'node_started' && event.step_name?.endsWith('work')
            )
          ).toHaveLength(1);
          expect(
            events.filter(
              event => event.event_type === 'node_completed' && event.step_name?.endsWith('work')
            )
          ).toHaveLength(0);
          expect(
            events.filter(
              event => event.event_type === 'node_suspended' && event.step_name?.endsWith('review')
            )
          ).toHaveLength(1);
        } finally {
          transport.mockRestore();
          f.unsubscribe();
        }
      }
    );
  }

  for (const { path, nodes, name } of [
    ...paths.map(path => ({ path, nodes: undefined, name: path })),
    {
      path: 'ordinary' as const,
      nodes: [{ id: 'wait', wait: { duration_ms: 1000 } }],
      name: 'wait',
    },
    ...[{ approval: { message: 'Review' } }, { wait: { duration_ms: 1000 } }].map(node => ({
      path: 'ordinary' as const,
      nodes: [
        {
          id: 'group',
          loop_group: {
            max_iterations: 2,
            until_bash: 'echo done',
            nodes: [{ id: 'interaction', ...node }],
          },
        },
      ],
      name: `nested ${'approval' in node ? 'gate' : 'wait'}`,
    })),
  ]) {
    it(`${name}: stale publication preserves a running successor`, async () => {
      const f = await setup(path, nodes);
      let successor: WorkflowRun | undefined;
      const resumeBeforePublication = async () => {
        await f.store.pauseWorkflowRun(f.run.id, approval);
        successor = await f.store.resumeWorkflowRun(f.run.id);
      };
      try {
        const result = await f.execute({
          pauseWorkflowRun: async (...args) => {
            await resumeBeforePublication();
            await f.store.pauseWorkflowRun(...args);
          },
          pauseWorkflowRunForWait: async (...args) => {
            await resumeBeforePublication();
            await f.store.pauseWorkflowRunForWait(...args);
          },
        });
        expect(result.success).toBe(false);
        expect(successor).toBeDefined();
        const next = await f.store.getWorkflowRun(f.run.id);
        expect(next?.status).toBe('running');
        expect(next?.metadata).toEqual(successor?.metadata);
        expect(f.stop).not.toHaveBeenCalled();
        expect(f.backend.applyChanges).not.toHaveBeenCalled();
        expect(f.backend.discardChanges).not.toHaveBeenCalled();
      } finally {
        f.unsubscribe();
      }
    });
  }

  for (const path of paths) {
    it.each([false, true])(
      `${path}: resume wins before cleanup (successor paused=%s)`,
      async pausedAgain => {
        const f = await setup(path);
        const successor: { run?: WorkflowRun } = {};
        const resume = async () => {
          successor.run = await f.store.resumeWorkflowRun(f.run.id);
          if (pausedAgain) await f.store.pauseWorkflowRun(f.run.id, approval);
        };
        const overrides: Partial<IWorkflowStore> = {
          pauseWorkflowRun: async (...args) => {
            await f.store.pauseWorkflowRun(...args);
            await resume();
          },
        };
        try {
          expect(await f.execute(overrides)).toEqual({
            success: true,
            paused: true,
            workflowRunId: f.run.id,
          });
          const next = await f.store.getWorkflowRun(f.run.id);
          expect(next?.status).toBe(pausedAgain ? 'paused' : 'running');
          expect(executionClaim(next?.metadata ?? {})).not.toBe(executionClaim(f.run.metadata));
          expect(executionClaim(next?.metadata ?? {})).toBe(
            executionClaim(successor.run?.metadata ?? {})
          );
          expect(f.stop).not.toHaveBeenCalled();
          expect(f.backend.suspend).not.toHaveBeenCalled();
          expect(stopped(f.live)).toEqual([]);
          const events = await f.store.listWorkflowEvents(f.run.id);
          expect(
            events.some(event =>
              ['workflow_completed', 'workflow_failed', 'container_stopped'].includes(
                event.event_type
              )
            )
          ).toBe(false);
          if (path !== 'ordinary') {
            expect(next?.metadata.pending_writeback).toEqual({ envId: 'env', summary });
            expect(next?.metadata.writeback_resolved).toBeUndefined();
            expect(f.backend.applyChanges).not.toHaveBeenCalled();
            expect(f.backend.discardChanges).not.toHaveBeenCalled();
          }
          expect(f.backend.prepareSuspend).toHaveBeenCalledWith('env', 'cid');
        } finally {
          f.unsubscribe();
        }
      }
    );

    it(`${path}: cancellation during preparation retains its terminal result and parent hook`, async () => {
      const f = await setup(path);
      const parent = await f.store.createWorkflowRun({
        workflow_name: 'parent',
        user_message: '',
        working_path: f.run.working_path ?? undefined,
      });
      let parentRead = false;
      f.backend.prepareSuspend.mockImplementation(async () => {
        await f.store.cancelWorkflowRun(f.run.id);
        return f.stop;
      });
      try {
        expect(
          await f.execute({
            getWorkflowRun: async id => {
              if (id === parent.id) parentRead = true;
              const run = await f.store.getWorkflowRun(id);
              return run?.id === f.run.id ? { ...run, parent_run_id: parent.id } : run;
            },
          })
        ).toMatchObject({ success: false });
        expect((await f.store.getWorkflowRun(f.run.id))?.status).toBe('cancelled');
        expect(parentRead).toBe(true);
        expect(f.stop).not.toHaveBeenCalled();
        expect(stopped(f.live)).toEqual([]);
      } finally {
        f.unsubscribe();
      }
    });

    it.each(['preparation', 'stop'] as const)(
      `${path}: %s failure survives a store completion failure`,
      async failure => {
        const f = await setup(path);
        const backendError = new Error(`${failure} failed before store completion`);
        const storeError = new Error('store completion failed');
        if (failure === 'preparation') f.backend.prepareSuspend.mockRejectedValue(backendError);
        else f.stop.mockRejectedValue(backendError);
        try {
          expect(
            await f.execute({
              withPausedExecution: async (id, claim, action) => {
                await f.store.withPausedExecution(id, claim, action);
                throw storeError;
              },
            })
          ).toMatchObject({ success: true, paused: true });
          for (const [error, diagnostic] of [
            [backendError, 'dag.container_suspend_on_pause_failed'],
            [storeError, 'dag.container_pause_cleanup_unconfirmed'],
          ] as const) {
            expect(
              mockLogFn.mock.calls.some(
                ([data, message]) =>
                  message === diagnostic &&
                  typeof data === 'object' &&
                  data !== null &&
                  'err' in data &&
                  data.err === error
              )
            ).toBe(true);
          }
          expect((await f.store.getWorkflowRun(f.run.id))?.status).toBe('paused');
          expect(stopped(f.live)).toEqual([]);
          expect(deliveredMessages(f.platform).join('\n')).toContain(
            'cleanup could not be confirmed'
          );
        } finally {
          f.unsubscribe();
        }
      }
    );

    it(`${path}: a losing preparation failure emits no stale diagnostic`, async () => {
      const f = await setup(path);
      const error = new Error('old preparation failed');
      f.backend.prepareSuspend.mockImplementation(async () => {
        await f.store.resumeWorkflowRun(f.run.id);
        throw error;
      });
      try {
        expect(await f.execute()).toMatchObject({ success: true, paused: true });
        expect((await f.store.getWorkflowRun(f.run.id))?.status).toBe('running');
        expect(f.stop).not.toHaveBeenCalled();
        expect(stopped(f.live)).toEqual([]);
        expect(deliveredMessages(f.platform).join('\n')).not.toContain(error.message);
      } finally {
        f.unsubscribe();
      }
    });

    it(`${path}: cleanup holds resume until stop settles`, async () => {
      const f = await setup(path);
      const entered = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const order: string[] = [];
      f.stop.mockImplementation(async () => {
        entered.resolve();
        await finish.promise;
        order.push('stopped');
      });
      const execution = f.execute();
      await entered.promise;
      const resume = f.store.resumeWorkflowRun(f.run.id).then(run => {
        order.push('resumed');
        return run;
      });
      finish.resolve();
      try {
        expect(await execution).toMatchObject({ success: true, paused: true });
        expect((await resume).status).toBe('running');
        expect(order).toEqual(['stopped', 'resumed']);
        expect(f.stop).toHaveBeenCalledTimes(1);
        expect(stopped(f.live)).toHaveLength(1);
      } finally {
        finish.resolve();
        await Promise.allSettled([execution, resume]);
        f.unsubscribe();
      }
    });

    it.each(['preparation', 'stop', 'store-before', 'store-after'] as const)(
      `${path}: %s failure preserves a successful pause`,
      async failure => {
        const f = await setup(path);
        const error = new Error(`${failure} failed`);
        if (failure === 'preparation') f.backend.prepareSuspend.mockRejectedValue(error);
        if (failure === 'stop') f.stop.mockRejectedValue(error);
        const overrides: Partial<IWorkflowStore> = failure.startsWith('store-')
          ? {
              withPausedExecution: async (id, claim, action) => {
                if (failure === 'store-after') await f.store.withPausedExecution(id, claim, action);
                throw error;
              },
            }
          : {};
        try {
          expect(await f.execute(overrides)).toMatchObject({ success: true, paused: true });
          expect((await f.store.getWorkflowRun(f.run.id))?.status).toBe('paused');
          expect(stopped(f.live)).toEqual([]);
          expect(
            (await f.store.listWorkflowEvents(f.run.id)).some(event =>
              ['workflow_failed', 'container_stopped'].includes(event.event_type)
            )
          ).toBe(false);
          expect(deliveredMessages(f.platform).join('\n')).toContain(error.message);
          expect(
            mockLogFn.mock.calls.some(
              ([data]) =>
                typeof data === 'object' && data !== null && 'err' in data && data.err === error
            )
          ).toBe(true);
        } finally {
          f.unsubscribe();
        }
      }
    );
  }
});

describe('wait pause transaction failures', () => {
  for (const nested of [false, true]) {
    it.each([
      { duration_ms: 3_600_000 },
      { until: '2099-01-01T00:00:00Z' },
      { event: 'signal', deadline_ms: 3_600_000 },
      { attention: 'Finish the action' },
    ])(
      `failed wait transaction remains visible behind a sibling pause (nested=${nested}): %j`,
      async wait => {
        const leaf = { id: 'delay', wait };
        const node = nested
          ? { id: 'group', loop_group: { max_iterations: 2, until_bash: 'true', nodes: [leaf] } }
          : leaf;
        const f = await setup('ordinary', [
          { id: 'review', approval: { message: 'Review' } },
          node,
        ]);
        const published = Promise.withResolvers<void>();
        const attempted = Promise.withResolvers<void>();
        try {
          await f.execute({
            pauseWorkflowRun: async (...args) => {
              await attempted.promise;
              await f.store.pauseWorkflowRun(...args);
              published.resolve();
            },
            pauseWorkflowRunForWait: async () => {
              attempted.resolve();
              await published.promise;
              throw new Error('Wait pause transaction rejected');
            },
          });
          expect((await f.store.getWorkflowRun(f.run.id))?.status).toBe('paused');
          const events = (await f.store.listWorkflowEvents(f.run.id)).filter(
            event => event.step_name === (nested ? 'group.delay' : 'delay')
          );
          expect(events.map(event => event.event_type)).toEqual(['node_started', 'node_failed']);
          expect(JSON.stringify(events.at(-1)?.data)).toContain('Wait pause transaction rejected');
        } finally {
          published.resolve();
          f.unsubscribe();
        }
      }
    );
  }
});
