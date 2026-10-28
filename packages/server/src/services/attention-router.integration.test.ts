import { Pool } from 'pg';
import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import webPush from 'web-push';
import { OpenAPIHono } from '@hono/zod-openapi';
import { closeDatabase, getDatabase, resetDatabase } from '@archon/core/db/connection';
import { createWorkflowRun } from '@archon/core/db/workflows';
import {
  getDagResumeSnapshot,
  insertWorkflowEvent,
  listAttentionNotices,
} from '@archon/core/db/workflow-events';
import { webPushPayloadSchema } from '@archon/core/schemas/web-push';
import { listWebPushSubscriptions } from '@archon/core/db/web-push-subscriptions';
import { removeTempTree } from '@archon/paths/test-utils';
import { ConversationLockManager } from '@archon/core/utils/conversation-lock';
import { registerApiRoutes } from '../routes/api';
import { validationErrorHook } from '../routes/openapi-defaults';
import { WebAdapter } from '../adapters/web';
import { SSETransport } from '../adapters/web/transport';
import { MessagePersistence } from '../adapters/web/persistence';
import { WorkflowEventBridge } from '../adapters/web/workflow-bridge';
import { AttentionRouter } from './attention-router';
import { loadVapidKeys, WebPushDestination } from './web-push';

let root: string;
let savedHome: string | undefined;
let savedDatabase: string | undefined;
let userId: string;
const postgresUrl = process.env.ARCHON_TEST_PG_URL;
let postgresAdmin: Pool | undefined;
let scratchDatabase: string | undefined;
let savedAuthSecret: string | undefined;
const subscription = (name: string) => ({
  endpoint: `https://push.example/${name}`,
  keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) },
});
const sent = { statusCode: 201, headers: {}, body: '' };
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'archon-push-test-'));
  savedHome = process.env.ARCHON_HOME;
  savedDatabase = process.env.DATABASE_URL;
  process.env.ARCHON_HOME = root;
  process.env.DATABASE_URL = '';
  savedAuthSecret = process.env.BETTER_AUTH_SECRET;
  process.env.BETTER_AUTH_SECRET = '';
  if (postgresUrl) {
    postgresAdmin = new Pool({ connectionString: postgresUrl });
    scratchDatabase = `archon_attention_${crypto.randomUUID().replaceAll('-', '')}`;
    await postgresAdmin.query(`CREATE DATABASE "${scratchDatabase}"`);
    const url = new URL(postgresUrl);
    url.pathname = `/${scratchDatabase}`;
    process.env.DATABASE_URL = url.toString();
  }
  resetDatabase();
  userId = crypto.randomUUID();
  await getDatabase().query('INSERT INTO remote_agent_users (id) VALUES ($1)', [userId]);
});
afterEach(async () => {
  await closeDatabase();
  if (postgresAdmin && scratchDatabase) {
    try {
      await postgresAdmin.query(`DROP DATABASE "${scratchDatabase}" WITH (FORCE)`);
    } finally {
      await postgresAdmin.end();
      postgresAdmin = undefined;
      scratchDatabase = undefined;
    }
  }
  if (savedAuthSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = savedAuthSecret;
  if (savedHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = savedHome;
  if (savedDatabase === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabase;
  await removeTempTree(root);
});
async function pause(pauseId = 'first', metadata?: Record<string, unknown>): Promise<string> {
  const run = await createWorkflowRun({
    workflow_name: 'nightly',
    user_message: 'private input',
    origin: { userId },
  });
  await getDatabase().query(
    "UPDATE remote_agent_workflow_runs SET status = 'paused', metadata = $1 WHERE id = $2",
    [
      JSON.stringify(
        metadata ?? { approval: { nodeId: 'review', pauseId, message: 'private gate' } }
      ),
      run.id,
    ]
  );
  return run.id;
}

test('activation is quiet; new occurrences and terminal follow-ups survive repeated scans and restart', async () => {
  const sender = mock<typeof webPush.sendNotification>(async () => sent);
  const destination = new WebPushDestination(new Set(), sender);
  const stale = await pause();
  await destination.subscribe(userId, subscription('one'));
  const router = new AttentionRouter([destination], new Set());
  await router.scan();
  expect(sender).not.toHaveBeenCalled();
  expect((await listAttentionNotices([stale]))[0]?.data).toEqual({
    destination: 'web-push',
    key: 'review:first',
    baseline: true,
  });
  const current = await pause('first', {
    approval: {
      nodeId: 'review',
      pauseId: 'first',
      message: 'private declared decision',
      type: 'approval',
      decisionsAuthored: true,
      decisions: [
        { id: 'ship', label: 'Ship' },
        { id: 'rework', label: 'Rework' },
      ],
    },
  });
  await Promise.all([router.scan(), router.scan()]);
  await new AttentionRouter([destination], new Set()).scan();
  expect(sender).toHaveBeenCalledTimes(1);
  expect(sender.mock.calls[0]?.[0]).toEqual(subscription('one'));
  expect(sender.mock.calls[0]?.[2]).toEqual({
    vapidDetails: { subject: 'https://archon.diy', ...loadVapidKeys() },
    timeout: 10_000,
  });
  expect(JSON.parse(String(sender.mock.calls[0]?.[1]))).toEqual({
    runId: current,
    workflowName: 'nightly',
    kind: 'gate',
  });
  await getDatabase().query('UPDATE remote_agent_workflow_runs SET metadata = $1 WHERE id = $2', [
    JSON.stringify({
      approval: {
        nodeId: 'review',
        pauseId: 'second',
        message: 'private second gate',
        type: 'interactive_loop',
      },
    }),
    current,
  ]);
  await router.scan();
  expect(sender).toHaveBeenCalledTimes(2);
  await getDatabase().query(
    "UPDATE remote_agent_workflow_runs SET status = 'completed' WHERE id IN ($1, $2)",
    [current, stale]
  );
  await router.scan();
  await router.scan();
  expect(sender).toHaveBeenCalledTimes(3);
  expect(JSON.parse(String(sender.mock.calls[2]?.[1]))).toEqual({
    runId: current,
    workflowName: 'nightly',
    kind: 'terminal',
  });
  expect((await listAttentionNotices([stale])).length).toBe(1);
  const snapshot = await getDagResumeSnapshot(current);
  expect(snapshot.completedNodeOutputs.size).toBe(0);
  expect(snapshot.unresolvedNodeStarts.size).toBe(0);
  expect(snapshot.costUsd).toBeUndefined();
});

test('empty activation survives restart and failure retries all browsers without a premature ledger row', async () => {
  let fail = true;
  const sender = mock<typeof webPush.sendNotification>(async sub => {
    expect(await listAttentionNotices([runId])).toEqual([]);
    if (fail && sub.endpoint.endsWith('/two'))
      throw new webPush.WebPushError(
        'private endpoint in vendor message',
        503,
        {},
        'private body',
        sub.endpoint
      );
    return sent;
  });
  const destination = new WebPushDestination(new Set(), sender);
  await destination.subscribe(userId, subscription('one'));
  await destination.subscribe(userId, subscription('two'));
  const runId = await pause();
  const output = spyOn(process.stdout, 'write').mockImplementation(() => true);
  let lines: string[];
  try {
    await new AttentionRouter([destination], new Set()).scan();
    lines = output.mock.calls.map(call => String(call[0]));
  } finally {
    output.mockRestore();
  }
  expect(lines.join('')).not.toContain('https://push.example');
  expect(lines.join('')).not.toContain('private endpoint');
  expect(lines.join('')).not.toContain('private body');
  expect(lines.join('')).not.toContain(subscription('one').keys.auth);
  expect(lines.join('')).not.toContain(userId);
  expect(await listAttentionNotices([runId])).toEqual([]);
  fail = false;
  await new AttentionRouter([destination], new Set()).scan();
  await new AttentionRouter([destination], new Set()).scan();
  expect(sender).toHaveBeenCalledTimes(4);
  expect((await listAttentionNotices([runId])).length).toBe(1);
});

test.each([404, 410])(
  '%i removes only the expired browser and still sends to every other subscriber',
  async status => {
    const sender = mock<typeof webPush.sendNotification>(async sub => {
      if (sub.endpoint.endsWith('/expired'))
        throw new webPush.WebPushError('gone', status, {}, '', sub.endpoint);
      return sent;
    });
    const destination = new WebPushDestination(new Set(), sender);
    await destination.subscribe(userId, subscription('expired'));
    await destination.subscribe(userId, subscription('live'));
    const runId = await pause('action', {
      wait: {
        kind: 'attention',
        owner: 'node',
        nodeId: 'hold',
        waitingSince: '2026-10-13T01:00:00.000Z',
        message: 'private action',
      },
    });
    await new AttentionRouter([destination], new Set()).scan();
    expect(sender).toHaveBeenCalledTimes(2);
    for (const call of sender.mock.calls)
      expect(JSON.parse(String(call[1]))).toEqual({
        runId,
        workflowName: 'nightly',
        kind: 'attention',
      });
    expect((await listWebPushSubscriptions()).map(row => row.endpoint)).toEqual([
      subscription('live').endpoint,
    ]);
    expect((await listAttentionNotices([runId]))[0]?.data.key).toBe('hold:legacy:hold');
  }
);

test('a failed ledger write retries after sending, and no subscribers write no rows', async () => {
  const sender = mock<typeof webPush.sendNotification>(async () => sent);
  const destination = new WebPushDestination(new Set(), sender);
  const router = new AttentionRouter([destination], new Set());
  await destination.subscribe(userId, subscription('one'));
  const runId = await pause();
  const db = getDatabase();
  const query = db.query.bind(db);
  const write = spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (
      sql.startsWith('INSERT INTO remote_agent_workflow_events') &&
      params?.[2] === 'attention_notice_sent'
    )
      throw new Error('disk unavailable');
    return query(sql, params);
  });
  try {
    await router.scan();
  } finally {
    write.mockRestore();
  }
  expect(sender).toHaveBeenCalledTimes(1);
  expect(await listAttentionNotices([runId])).toEqual([]);
  await router.scan();
  expect(sender).toHaveBeenCalledTimes(2);
  await db.query('DELETE FROM remote_agent_web_push_subscriptions');
  const other = await pause();
  await router.scan();
  expect(await listAttentionNotices([other])).toEqual([]);
});

test('inline plugin conversations and their originless children are excluded; web conversations are selected', async () => {
  const sender = mock<typeof webPush.sendNotification>(async () => sent);
  const inline = new Set(['fixture-chat']);
  const destination = new WebPushDestination(inline, sender);
  await destination.subscribe(userId, subscription('one'));
  const parent = await pause();
  const child = await pause();
  const web = await pause();
  const chatConversation = crypto.randomUUID();
  const webConversation = crypto.randomUUID();
  const db = getDatabase();
  for (const [id, platform] of [
    [chatConversation, 'fixture-chat'],
    [webConversation, 'web'],
  ])
    await db.query(
      'INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id) VALUES ($1, $2, $3)',
      [id, platform, id]
    );
  await db.query(
    'UPDATE remote_agent_workflow_runs SET parent_conversation_id = $1 WHERE id = $2',
    [chatConversation, parent]
  );
  await db.query('UPDATE remote_agent_workflow_runs SET parent_run_id = $1 WHERE id = $2', [
    parent,
    child,
  ]);
  await db.query(
    'UPDATE remote_agent_workflow_runs SET parent_conversation_id = $1 WHERE id = $2',
    [webConversation, web]
  );
  await new AttentionRouter([destination], inline).scan();
  expect(sender).toHaveBeenCalledTimes(1);
  expect(webPushPayloadSchema.parse(JSON.parse(String(sender.mock.calls[0]?.[1]))).runId).toBe(web);
});

test('an inline conversation is pushed once when its pause notice was not delivered', async () => {
  const sender = mock<typeof webPush.sendNotification>(async () => sent);
  const inline = new Set(['fixture-chat']);
  const destination = new WebPushDestination(inline, sender);
  await destination.subscribe(userId, subscription('one'));
  const router = new AttentionRouter([destination], inline);
  const undelivered = await pause('now');
  const delivered = await pause('now');
  const staleFailure = await pause('now');
  const conversation = crypto.randomUUID();
  const db = getDatabase();
  await db.query(
    'INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id) VALUES ($1, $2, $3)',
    [conversation, 'fixture-chat', conversation]
  );
  for (const id of [undelivered, delivered, staleFailure])
    await db.query(
      'UPDATE remote_agent_workflow_runs SET parent_conversation_id = $1 WHERE id = $2',
      [conversation, id]
    );
  const failed = (runId: string, occurrence: string) =>
    insertWorkflowEvent((sql, params) => db.query(sql, params), {
      workflow_run_id: runId,
      event_type: 'pause_notice_undelivered',
      step_name: 'review',
      data: { nodeId: 'review', occurrence, platform: 'fixture-chat' },
    });
  await router.scan();
  await failed(undelivered, 'now');
  await failed(staleFailure, 'earlier');
  await router.scan();
  await router.scan();
  expect(sender).toHaveBeenCalledTimes(1);
  expect(webPushPayloadSchema.parse(JSON.parse(String(sender.mock.calls[0]?.[1]))).runId).toBe(
    undelivered
  );
});

test('subscription routes require identity, validate shared schemas and create/delete idempotently', async () => {
  const app = new OpenAPIHono({ defaultHook: validationErrorHook });
  const transport = new SSETransport();
  const adapter = new WebAdapter(
    transport,
    new MessagePersistence((id, event) => transport.emit(id, event)),
    new WorkflowEventBridge(transport)
  );
  registerApiRoutes(app, adapter, new ConversationLockManager());
  const body = JSON.stringify(subscription('api'));
  const request = (method: string, identity: string | false = 'push-test-operator', data = body) =>
    app.request('/api/web-push/subscriptions', {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(identity ? { 'X-Archon-User': identity } : {}),
      },
      body: data,
    });
  for (const method of ['POST', 'DELETE']) expect((await request(method, false)).status).toBe(401);
  expect(
    (
      await request(
        'POST',
        'push-test-operator',
        JSON.stringify({ ...subscription('api'), endpoint: 'http://insecure.example' })
      )
    ).status
  ).toBe(400);
  expect(
    (
      await request(
        'POST',
        'push-test-operator',
        JSON.stringify({ ...subscription('api'), endpoint: 'not-a-url' })
      )
    ).status
  ).toBe(400);
  for (let i = 0; i < 2; i++) expect((await request('POST')).status).toBe(200);
  const ownedSubscriptions = await listWebPushSubscriptions();
  expect(ownedSubscriptions.length).toBe(1);
  expect((await request('DELETE', 'another-push-operator')).status).toBe(200);
  expect(await listWebPushSubscriptions()).toEqual(ownedSubscriptions);
  expect((await request('POST', 'another-push-operator')).status).toBe(200);
  expect(await listWebPushSubscriptions()).toEqual(ownedSubscriptions);
  for (let i = 0; i < 2; i++) expect((await request('DELETE')).status).toBe(200);
  expect(await listWebPushSubscriptions()).toEqual([]);
  transport.stop();
});

test('VAPID keys are stable and owner-only', () => {
  const first = loadVapidKeys();
  expect(loadVapidKeys()).toEqual(first);
  // POSIX-only: Windows does not honor 0600 file modes (statSync reports 0666).
  if (process.platform !== 'win32') {
    expect(statSync(join(root, 'web-push-vapid.json')).mode & 0o777).toBe(0o600);
  }
});

test('if every subscription expired, no delivery is recorded', async () => {
  const sender = mock<typeof webPush.sendNotification>(async sub => {
    throw new webPush.WebPushError('gone', 410, {}, '', sub.endpoint);
  });
  const destination = new WebPushDestination(new Set(), sender);
  await destination.subscribe(userId, subscription('expired'));
  const runId = await pause();
  const router = new AttentionRouter([destination], new Set());
  await router.scan();
  await router.scan();
  expect(sender).toHaveBeenCalledTimes(1);
  expect(await listAttentionNotices([runId])).toEqual([]);
  expect(await listWebPushSubscriptions()).toEqual([]);
});

test('malformed VAPID files do not expose their contents through parser errors', () => {
  writeFileSync(join(root, 'web-push-vapid.json'), 'recognizablePrivateKeyFixture', {
    mode: 0o600,
  });
  expect(() => loadVapidKeys()).toThrow('VAPID key file is not valid JSON');
});

test('subscription primary keys are required on both database adapters', async () => {
  const sub = subscription('missing-id');
  await expect(
    getDatabase().query(
      `INSERT INTO remote_agent_web_push_subscriptions
    (id, user_id, endpoint, p256dh, auth) VALUES (NULL, $1, $2, $3, $4)`,
      [userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth]
    )
  ).rejects.toThrow();
});
