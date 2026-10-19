// @archon-test-isolated
import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileWorkflowStore } from '@archon/workflows/file-store';
import { watchAttentionQueue, type AttentionStreamLine } from '@archon/workflows/attention-watch';
import { executionClaim, type IWorkflowStore } from '@archon/workflows/store';
import { trackTempRoots, testTimeout } from '@archon/paths/test-utils';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { linkSync, renameSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { hostname } from 'node:os';
import { RUN_LIVE_OWNER_IPC_TIMEOUT_MS, runLiveOwnerPath } from './run-live-owner';

const rows = new Map<string, WorkflowRun>();
const store = { getWorkflowRun: async (id: string) => rows.get(id) ?? null };
const { waitForRunAttention, runOwnerLossWatch } = await import('./run-attention-watch');

const localUid = process.getuid?.();
const localOwner = {
  execution_owner: {
    host: hostname(),
    pid: process.pid,
    ...(localUid === undefined ? {} : { uid: localUid }),
  },
};

function runningRun(metadata: Record<string, unknown> = localOwner): WorkflowRun {
  const run: WorkflowRun = {
    origin: { conversationId: 'conv-1' },
    id: crypto.randomUUID(),
    workflow_name: 'demo',
    conversation_id: 'conv-1',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running',
    outcome: null,
    user_message: 'go',
    metadata,
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: null,
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: null,
    checkout_baseline: null,
  };
  rows.set(run.id, run);
  return run;
}

async function listen(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()));
}

describe('attention wait with a real owner endpoint', () => {
  test(
    'retries slow handshakes and later resolves on owner attention',
    async () => {
      const run = runningRun();
      const path = runLiveOwnerPath(run.id);
      const sockets = new Set<Socket>();
      const timers = new Set<ReturnType<typeof setTimeout>>();
      let requests = 0;
      let watcher: Socket | undefined;
      const server = createServer(socket => {
        sockets.add(socket);
        socket.on('error', () => undefined);
        socket.once('close', () => sockets.delete(socket));
        socket.once('data', () => {
          requests += 1;
          if (requests <= 2) {
            // Both opening probes must exceed the real IPC timeout, which used to
            // make the waiter report owner_lost before this owner recovered.
            timers.add(
              setTimeout(() => socket.end('watching\n'), RUN_LIVE_OWNER_IPC_TIMEOUT_MS + 100)
            );
          } else {
            watcher = socket;
            socket.write('watching\n');
          }
        });
      });
      await listen(server, path);
      try {
        const result = await waitForRunAttention(store, run.id, {
          pollIntervalMs: 5,
          deadlineMs: 10_000,
          onAttached: () => {
            run.status = 'completed';
            run.completed_at = new Date();
            watcher?.end('attention\n');
          },
        });
        expect(result).toMatchObject({
          kind: 'attention',
          attention: { kind: 'terminal', runId: run.id, status: 'completed' },
        });
        expect(requests).toBeGreaterThanOrEqual(3);
      } finally {
        for (const timer of timers) clearTimeout(timer);
        for (const socket of sockets) socket.destroy();
        await close(server);
        rows.delete(run.id);
        if (process.platform !== 'win32') rmSync(path, { force: true });
      }
    },
    testTimeout(15_000)
  );

  test(
    'retries pre-handshake disconnects until the explicit deadline',
    async () => {
      const run = runningRun();
      const path = runLiveOwnerPath(run.id);
      const sockets = new Set<Socket>();
      let requests = 0;
      const server = createServer(socket => {
        sockets.add(socket);
        socket.on('error', () => undefined);
        socket.once('close', () => sockets.delete(socket));
        socket.once('data', () => {
          requests += 1;
          socket.end();
        });
      });
      await listen(server, path);
      try {
        expect(
          await waitForRunAttention(store, run.id, {
            pollIntervalMs: 5,
            deadlineMs: 250,
          })
        ).toEqual({
          kind: 'deadline',
          runId: run.id,
          observedStatus: 'running',
        });
        expect(requests).toBeGreaterThanOrEqual(2);
        expect(run.status).toBe('running');
      } finally {
        for (const socket of sockets) socket.destroy();
        await close(server);
        rows.delete(run.id);
        if (process.platform !== 'win32') rmSync(path, { force: true });
      }
    },
    testTimeout(6_000)
  );

  test.each(['missing', 'refused'] as const)('reports owner_lost for a %s endpoint', async kind => {
    if (kind === 'refused' && process.platform === 'win32') return;
    const run = runningRun();
    const path = runLiveOwnerPath(run.id);
    if (kind === 'refused') {
      const server = createServer();
      await listen(server, path);
      const residue = `${path}.residue`;
      linkSync(path, residue);
      await close(server);
      renameSync(residue, path);
    }
    try {
      expect(await waitForRunAttention(store, run.id, { deadlineMs: 1000 })).toEqual({
        kind: 'owner_lost',
        runId: run.id,
        observedStatus: 'running',
      });
      expect(run.status).toBe('running');
    } finally {
      rows.delete(run.id);
      if (process.platform !== 'win32') rmSync(path, { force: true });
    }
  });

  test('keeps watching a missing endpoint whose owner ran on another host', async () => {
    const run = runningRun({ execution_owner: { host: 'other-host.invalid', pid: 4242 } });
    try {
      expect(await waitForRunAttention(store, run.id, { deadlineMs: 250 })).toEqual({
        kind: 'deadline',
        runId: run.id,
        observedStatus: 'running',
      });
    } finally {
      rows.delete(run.id);
    }
  });
});

const roots = trackTempRoots();

test.each([1, 2])(
  'a resume before owner read %s cannot report the new loss under the old claim',
  async heldRead => {
    const files = await createFileWorkflowStore({
      root: roots(await mkdtemp(join(tmpdir(), 'archon-owner-claim-'))),
    });
    const run = await files.createWorkflowRun({ workflow_name: 'wf', user_message: '' });
    await files.claimPendingWorkflowRun(run.id);
    await files.updateWorkflowRun(run.id, { metadata: localOwner });
    const after = await files.getWorkflowEventHead();
    const reading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const checked = Promise.withResolvers<void>();
    const caughtUp = Promise.withResolvers<void>();
    const lines: AttentionStreamLine[] = [];
    let reads = 0;
    let checks = 0;
    let finished = 0;
    let held = true;
    const holding: IWorkflowStore = Object.create(files);
    holding.readWorkflowEventsAfter = (cursor, options) =>
      held
        ? Promise.resolve({ events: [], next: cursor })
        : files.readWorkflowEventsAfter(cursor, options);
    const ownerLoss = runOwnerLossWatch({
      getWorkflowRun: async id => {
        if (++reads === heldRead) {
          reading.resolve();
          await release.promise;
        }
        return files.getWorkflowRun(id);
      },
    });
    let head = after;
    const stream = await watchAttentionQueue(
      holding,
      {
        branchOf: async () => null,
        ownerLoss: async (...args) => {
          checks++;
          const result = await ownerLoss(...args);
          finished++;
          checked.resolve();
          return result;
        },
      },
      line => {
        lines.push(line);
        if (line.type === 'bookmark' && line.cursor === head && !held && finished === 2)
          caughtUp.resolve();
      },
      { scope: { kind: 'all' }, after, pollIntervalMs: 5, bookmarkIntervalMs: 0 }
    );
    try {
      await reading.promise;
      await files.failWorkflowRun(run.id, 'failed');
      const resumed = await files.resumeWorkflowRun(run.id);
      expect(executionClaim(resumed.metadata)).not.toBeNull();
      await files.updateWorkflowRun(run.id, { metadata: { ...resumed.metadata, ...localOwner } });
      head = await files.getWorkflowEventHead();
      release.resolve();
      await checked.promise;
      held = false;
      await caughtUp.promise;
    } finally {
      release.resolve();
      await stream.close();
    }
    expect(checks).toBe(2);
    expect(lines.filter(line => line.type === 'owner_lost')).toHaveLength(1);
    expect((await files.getWorkflowRun(run.id))?.status).toBe('running');
  }
);
