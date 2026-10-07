// @archon-test-isolated
import { removeTempTree } from '@archon/paths/test-utils';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, mock, test, expect } from 'bun:test';
import { toolCallAttentionContract } from './tool-call-attention.contract';

mock.module('@archon/paths', () => ({
  BUNDLED_IS_BINARY: false,
  createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {} }),
  captureApprovalResolved: () => undefined,
  isTelemetryDisabled: () => true,
  captureWorkflowTerminal: () => undefined,
}));
const { SqliteAdapter, sqliteDialect } = await import('./adapters/sqlite');
const scratchHome = await mkdtemp(join(tmpdir(), 'archon-tool-attention-'));
const db = new SqliteAdapter(join(scratchHome, 'archon.db'));
mock.module('./connection', () => ({
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
  getDbNotificationListener: () => null,
}));
const workflows = await import('./workflows');
mock.module('../services/run-live-owner', () => ({
  watchRunLiveOwner: async () => ({ kind: 'attached', handle: { unsubscribe() {} } }),
}));
const { waitForRunAttention } = await import('../services/run-attention-watch');
afterAll(async () => {
  await db.close();
  await removeTempTree(scratchHome);
});
describe('tool attention on SQLite', () => {
  toolCallAttentionContract(
    () => db,
    () => workflows
  );
});

test('a separate executor process publishes durable attention for an already attached waiter', async () => {
  const runId = crypto.randomUUID(),
    conversationId = crypto.randomUUID();
  await db.query(
    "INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id) VALUES ($1, 'test', $2)",
    [conversationId, conversationId]
  );
  await db.query(
    "INSERT INTO remote_agent_workflow_runs (id, conversation_id, workflow_name, user_message, status) VALUES ($1, $2, 'test', '', 'running')",
    [runId, conversationId]
  );
  const call = {
    streamId: 's',
    nodeId: 'implement',
    provider: 'codex',
    toolCallId: 'tool',
    name: 'bash',
    title: 'bun test',
    startedAt: '2026-10-01T00:00:00.000Z',
    lastProgressAt: '2026-10-01T00:00:00.000Z',
    raisedAt: '2026-10-01T00:30:00.000Z',
    thresholdMs: 1800000,
  };
  let attached: (() => void) | undefined;
  const ready = new Promise<void>(resolve => {
    attached = resolve;
  });
  const controller = new AbortController();
  const waiting = waitForRunAttention(runId, {
    pollIntervalMs: 5,
    deadlineMs: 3000,
    signal: controller.signal,
    onAttached: () => {
      attached?.();
    },
  });
  await ready;
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-env-file',
      '--eval',
      `
    const { setToolCallAttention } = await import(${JSON.stringify(new URL('./workflows.ts', import.meta.url).pathname)});
    await setToolCallAttention(${JSON.stringify(runId)}, 's', ${JSON.stringify([call])});
    process.exit(0);
  `,
    ],
    {
      env: {
        ...process.env,
        DATABASE_URL: '',
        ARCHON_HOME: scratchHome,
        ARCHON_TELEMETRY_DISABLED: 'true',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  try {
    expect(await child.exited).toBe(0);
    expect(await waiting).toMatchObject({
      kind: 'attention',
      attention: {
        kind: 'stalled_tool_calls',
        runId,
        status: 'running',
        calls: [{ nodeId: 'implement', title: 'bun test' }],
      },
    });
    expect((await workflows.getWorkflowRun(runId))!.status).toBe('running');
    await workflows.setToolCallAttention(runId, 's', []);
    expect((await workflows.getWorkflowRun(runId))!.metadata.tool_call_attention).toBeUndefined();
  } finally {
    controller.abort();
    await waiting;
  }
});
