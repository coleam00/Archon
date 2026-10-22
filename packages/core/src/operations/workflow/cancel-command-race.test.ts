// @archon-test-isolated
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { createFileWorkflowStore } from '@archon/workflows/file-store';
import { runSubprocess } from '@archon/workflows/subprocess';
import { createWorkflowOperations } from '../workflow-operations';
import {
  isolationStore,
  isRunOwnedByThisProcess,
  isRunOwnerAnswering,
  noOwnerAnswers,
} from './test-harness';
import { startRunLiveOwner, runLiveOwnerPath } from '../../services/run-live-owner';

const trackTempRoot = trackTempRoots();
const posix = process.platform === 'win32' ? test.skip : test;

for (const ownerKind of ['local', 'root', 'remote-root'] as const) {
  for (const target of ['parent', 'child', 'grandchild'] as const) {
    for (const runtime of ['sh', 'bun'] as const) {
      posix(
        `${ownerKind} cancellation reports a late ${runtime} command in ${target}`,
        async () => {
          const dir = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-cancel-race-')));
          const store = await createFileWorkflowStore({ root: join(dir, 'store') });
          async function running(name: string, parentId?: string) {
            const run = await store.createWorkflowRun({
              workflow_name: name,
              user_message: '',
              working_path: join(dir, name),
              ...(parentId ? { parent_run_id: parentId } : {}),
            });
            await store.claimPendingWorkflowRun(run.id);
            return run;
          }
          const root = await running('root');
          const parent = ownerKind === 'local' ? root : await running('parent', root.id);
          const child = await running('child', parent.id);
          const grandchild = await running('grandchild', child.id);
          const affected = { parent, child, grandchild }[target];
          const listener =
            ownerKind === 'remote-root' ? createServer(socket => socket.destroy()) : undefined;
          if (listener)
            await new Promise<void>(resolve => listener.listen(runLiveOwnerPath(root.id), resolve));
          const owner = listener
            ? { close: () => new Promise<void>(resolve => listener.close(() => resolve())) }
            : await startRunLiveOwner(root.id);
          const pidFile = join(dir, 'job');
          let admitted = false;
          let survivor: number | undefined;
          const operations = createWorkflowOperations({
            getUserRole: async () => undefined,
            store: {
              ...store,
              deleteWorkflowRun: async () => {
                throw new Error('unused');
              },
              findChildRuns: async id => {
                if (id === affected.id && !admitted) {
                  admitted = true;
                  // Admission occurs after this run's old history snapshot, before terminal cancel.
                  await store.persistWorkflowEvent({
                    workflow_run_id: affected.id,
                    event_type: 'node_started',
                    step_name: 'late',
                    data: { type: runtime === 'sh' ? 'bash' : 'script' },
                  });
                  const command = runtime === 'sh' ? '/bin/sh' : process.execPath;
                  const body =
                    runtime === 'sh'
                      ? `/bin/sleep 30 </dev/null >/dev/null 2>&1 & echo $! > '${pidFile}'`
                      : `const job = Bun.spawn(['/bin/sleep', '30'], {stdio: ['ignore', 'ignore', 'ignore']}); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(job.pid)); job.unref();`;
                  await runSubprocess(
                    { kind: 'host' },
                    command,
                    [runtime === 'sh' ? '-c' : '-e', body],
                    {
                      cwd: dir,
                      env: {},
                      retention: { standalone: true },
                    }
                  );
                  survivor = Number(readFileSync(pidFile, 'utf8'));
                  await store.persistWorkflowEvent({
                    workflow_run_id: affected.id,
                    event_type: 'node_completed',
                    step_name: 'late',
                    data: { type: runtime === 'sh' ? 'bash' : 'script' },
                  });
                }
                return store.findChildRuns(id);
              },
            },
            hostStore: { isolation: isolationStore },
            requestDetachedRunStop: noOwnerAnswers,
            isRunOwnedByThisProcess,
            isRunOwnerAnswering,
            reclaimContainerEnv: async () => {},
            reclaimRunWorktree: async () => ({ warnings: [] }),
          });
          try {
            const result = await operations.cancelWorkflow(parent.id, { kind: 'operator' });
            expect(admitted).toBe(true);
            expect(result).toMatchObject({ kind: 'cooperative', cancelled: true });
            expect(result.cleanupWarnings).toContainEqual(
              expect.stringContaining(`Run ${affected.id} checkout`)
            );
            expect(result.cleanupWarnings?.join(' ')).toContain(
              'Host commands that started or completed'
            );
            expect(survivor).toBeGreaterThan(0);
            if (survivor !== undefined) expect(process.kill(survivor, 0)).toBe(true);
            const terminal = (await store.listWorkflowEvents(parent.id)).find(
              e => e.event_type === 'workflow_cancelled'
            );
            expect(terminal?.data?.warnings).toEqual(result.cleanupWarnings);
            expect(terminal?.data?.reason).toBe(result.cleanupWarnings?.join('\n'));
            const completed = (await store.listWorkflowEvents(affected.id)).find(
              e => e.event_type === 'node_completed'
            );
            if (!completed || !terminal)
              throw new Error('Missing completion or cancellation event');
            expect(completed.created_at <= terminal.created_at).toBe(true);
          } finally {
            if (survivor !== undefined) process.kill(survivor, 'SIGKILL');
            await owner.close();
          }
        }
      );
    }
  }
}
