import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { canonicalizeProjectPath } from '@archon/paths';
import { removeTempTree } from '@archon/paths/test-utils';
import {
  canConnect,
  detachedRunControlPath,
  requestDetachedRunStop,
} from '../utils/detached-run-control';

const cleanupPaths: string[] = [];
const activeRunIds = new Set<string>();

// Deliberately one explicit hook rather than `trackTempRoots()` from the same module:
// a still-running owner has to be stopped before its tree can be removed, and splitting
// that into two `afterEach` hooks would leave the order they were registered in as the
// only thing keeping it correct.
afterEach(async () => {
  for (const runId of activeRunIds) {
    try {
      const target = await requestDetachedRunStop(runId);
      await target.stop();
    } catch {
      // A completed owner has already removed its endpoint.
    }
  }
  activeRunIds.clear();
  for (const path of cleanupPaths.splice(0)) {
    await removeTempTree(path);
  }
});

async function waitFor<T>(
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 15_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(25);
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for detached workflow${detail}`);
}

function readRun(
  databasePath: string,
  workflowName: string
): { id: string; status: string } | undefined {
  if (!existsSync(databasePath)) return undefined;
  const database = new Database(databasePath, { readonly: true });
  try {
    return (
      database
        .query<{ id: string; status: string }, [string]>(
          `SELECT id, status FROM remote_agent_workflow_runs
         WHERE workflow_name = ? ORDER BY started_at DESC LIMIT 1`
        )
        .get(workflowName) ?? undefined
    );
  } finally {
    database.close();
  }
}

/** The run row named by an ack, without waiting for it to appear (#2872). */
function readRunById(
  databasePath: string,
  runId: string
): { id: string; status: string; working_path: string | null } | undefined {
  if (!existsSync(databasePath)) return undefined;
  const database = new Database(databasePath, { readonly: true });
  try {
    // The last writer's WAL cleanup can briefly lock a new reader. Wait for that
    // lock, not for the acknowledged row to appear.
    database.run('PRAGMA busy_timeout = 5000');
    return (
      database
        .query<
          { id: string; status: string; working_path: string | null },
          [string]
        >('SELECT id, status, working_path FROM remote_agent_workflow_runs WHERE id = ?')
        .get(runId) ?? undefined
    );
  } finally {
    database.close();
  }
}

function readTerminalEvents(
  databasePath: string,
  runId: string,
  eventType: string
): { data: string }[] {
  const database = new Database(databasePath, { readonly: true });
  try {
    return database
      .query<{ data: string }, [string, string]>(
        `SELECT data FROM remote_agent_workflow_events
         WHERE workflow_run_id = ? AND event_type = ? ORDER BY event_order`
      )
      .all(runId, eventType);
  } finally {
    database.close();
  }
}

describe('detached workflow terminal database events', () => {
  test('persists one matching event before successful and failed owners exit', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'archon-terminal-event-'));
    cleanupPaths.push(fixtureRoot);
    const archonHome = join(fixtureRoot, 'home');
    const projectRoot = join(fixtureRoot, 'project');
    const workflowsDir = join(projectRoot, '.archon', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(
      join(workflowsDir, 'terminal-success.yaml'),
      'name: terminal-success\ndescription: Detached terminal success fixture.\nnodes:\n  - id: finish\n    bash: "echo done"\n'
    );
    writeFileSync(
      join(workflowsDir, 'terminal-failure.yaml'),
      'name: terminal-failure\ndescription: Detached terminal failure fixture.\nnodes:\n  - id: fail\n    bash: "echo failed >&2; exit 42"\n'
    );

    const cliPath = resolve(import.meta.dir, '..', 'cli.ts');
    const databasePath = join(archonHome, 'archon.db');
    const cases = [
      { workflow: 'terminal-success', status: 'completed', event: 'workflow_completed' },
      { workflow: 'terminal-failure', status: 'failed', event: 'workflow_failed' },
    ] as const;

    for (const fixture of cases) {
      const conversationId = `terminal-event-${fixture.workflow}-${crypto.randomUUID()}`;
      const launcher = Bun.spawn(
        [
          process.execPath,
          cliPath,
          'workflow',
          'run',
          fixture.workflow,
          'terminal event integration',
          '--folder',
          '--detach',
          '--json',
          '--conversation-id',
          conversationId,
        ],
        {
          cwd: projectRoot,
          env: { ...process.env, ARCHON_HOME: archonHome },
          stdout: 'pipe',
          stderr: 'pipe',
        }
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        launcher.exited,
        new Response(launcher.stdout).text(),
        new Response(launcher.stderr).text(),
      ]);
      if (exitCode !== 0) throw new Error(`Detached launcher failed: ${stderr || stdout}`);
      const ack = JSON.parse(stdout.trim()) as { runId?: unknown };
      expect(ack).toMatchObject({ ok: true, detached: true });
      // #2872: `Started` means a queryable run. The launcher wrote the row before it
      // forked, so the id it acked names a row NOW — no waiting, no discovery query.
      const ackRunId = ack.runId;
      if (typeof ackRunId !== 'string') throw new Error(`ack carried no run id: ${stdout}`);
      expect(readRunById(databasePath, ackRunId)?.id).toBe(ackRunId);

      const created = await waitFor(() => readRun(databasePath, fixture.workflow));
      activeRunIds.add(created.id);
      expect(created.id).toBe(ackRunId);
      // The child fills in the checkout the parent could not know at fork time.
      // Canonicalize with the same function the CLI does (macOS's tmpdir is a
      // symlink; Windows CI's is an 8.3 short path), because the recorded
      // `working_path` is whatever that function returned — a different realpath
      // variant here disagrees with it on Windows (#2927).
      const resolvedProjectRoot = await canonicalizeProjectPath(projectRoot);
      await waitFor(() =>
        readRunById(databasePath, created.id)?.working_path === resolvedProjectRoot
          ? true
          : undefined
      );
      // `canConnect` is the owner's own probe. The copy that used to live here timed the
      // connect out after 250ms and reported a live endpoint as gone whenever CI starved
      // the loop past that. Returning from this wait is the assertion that the owner
      // released its endpoint; re-asserting the same reading on the next line could only
      // turn one such misread into a failure, which is how it failed on Windows.
      await waitFor(async () =>
        (await canConnect(detachedRunControlPath(created.id))) ? undefined : true
      );
      activeRunIds.delete(created.id);

      const terminal = await waitFor(() => {
        const run = readRun(databasePath, fixture.workflow);
        return run?.status === fixture.status ? run : undefined;
      });
      expect(terminal.id).toBe(created.id);
      // Not a write-ordering gap: `completeWorkflowRun` and `failWorkflowRun` write the
      // status UPDATE and the event INSERT inside one `withTransaction`, so a reader can
      // never see the terminal status without the event. What retries here is the READ.
      // Opening a second readonly connection against a database that is still settling
      // that commit fails outright on Windows — `SQLiteError: disk I/O error` from
      // `prepare()`, not an empty result (#2306). So this waits out reader-side
      // contention, and the count stays exact: the event was committed atomically with
      // the status already observed above, and the owner's endpoint is unreachable, so
      // nothing can append a second row after the first read succeeds.
      const events = await waitFor(() => {
        const rows = readTerminalEvents(databasePath, terminal.id, fixture.event);
        return rows.length > 0 ? rows : undefined;
      });
      expect(events).toHaveLength(1);
      const data = JSON.parse(events[0]?.data ?? '{}') as Record<string, unknown>;
      if (fixture.status === 'completed') expect(data.duration_ms).toBeNumber();
      else expect(data.error).toContain('fail');
    }
  }, 40_000);
});
