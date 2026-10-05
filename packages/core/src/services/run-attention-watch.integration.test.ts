import { describe, expect, mock, test } from 'bun:test';
import { testTimeout } from '@archon/paths/test-utils';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { linkSync, renameSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { RUN_LIVE_OWNER_IPC_TIMEOUT_MS, runLiveOwnerPath } from './run-live-owner';

const rows = new Map<string, WorkflowRun>();
mock.module('../db/workflows', () => ({
  getWorkflowRun: async (id: string) => rows.get(id) ?? null,
}));
mock.module('../db/connection', () => ({ getDbNotificationListener: () => null }));
const { waitForRunAttention } = await import('./run-attention-watch');

function runningRun(): WorkflowRun {
  const run: WorkflowRun = {
    id: crypto.randomUUID(),
    workflow_name: 'demo',
    conversation_id: 'conv-1',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running',
    outcome: null,
    user_message: 'go',
    metadata: {},
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
        const result = await waitForRunAttention(run.id, {
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
      expect(await waitForRunAttention(run.id, { deadlineMs: 1000 })).toEqual({
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
});
