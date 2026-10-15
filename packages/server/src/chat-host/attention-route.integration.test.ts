import { Pool } from 'pg';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatAttentionNoticeRequest } from '@archon/chat-contract';
import { closeDatabase, getDatabase, resetDatabase } from '@archon/core/db/connection';
import { createWorkflowRun } from '@archon/core/db/workflows';
import { listAttentionNotices } from '@archon/core/db/workflow-events';
import { ConversationLockManager } from '@archon/core/utils/conversation-lock';
import { removeTempTree, testTimeout } from '@archon/paths/test-utils';
import { AttentionRouter } from '../services/attention-router';
import { createChatHost } from './runtime';
import { descriptor } from './fixtures/descriptor';

let root: string;
let savedHome: string | undefined;
let savedDatabase: string | undefined;
let userId: string;
const postgresUrl = process.env.ARCHON_TEST_PG_URL;
let postgresAdmin: Pool | undefined;
let scratchDatabase: string | undefined;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'archon-chat-route-test-'));
  savedHome = process.env.ARCHON_HOME;
  savedDatabase = process.env.DATABASE_URL;
  process.env.ARCHON_HOME = root;
  process.env.DATABASE_URL = '';
  if (postgresUrl) {
    postgresAdmin = new Pool({ connectionString: postgresUrl });
    scratchDatabase = `archon_chat_route_${crypto.randomUUID().replaceAll('-', '')}`;
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
  if (savedHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = savedHome;
  if (savedDatabase === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabase;
  await removeTempTree(root);
});

async function pause(metadata: Record<string, unknown>): Promise<string> {
  const run = await createWorkflowRun({
    workflow_name: 'nightly',
    user_message: 'private input',
    origin: { userId },
  });
  await setRun(run.id, 'paused', metadata);
  return run.id;
}
async function setRun(id: string, status: string, metadata: Record<string, unknown>) {
  await getDatabase().query(
    'UPDATE remote_agent_workflow_runs SET status = $1, metadata = $2 WHERE id = $3',
    [status, JSON.stringify(metadata), id]
  );
}
const gate = (pauseId: string) => ({
  approval: {
    nodeId: 'review',
    pauseId,
    message: 'Ship it?',
    type: 'approval',
    decisionsAuthored: true,
    decisions: [{ id: 'ship', label: 'Ship' }, { id: 'rework' }],
  },
});
const routes = [
  { platform: 'fixture-chat', destination: 'ops' },
  { platform: 'missing-chat', destination: 'ops' },
];

test(
  'a chat route is quiet on activation, sends one notice per occurrence across scans and restart, and threads the terminal follow-up',
  async () => {
    const file = join(root, 'notices.jsonl');
    writeFileSync(file, '');
    const received = (): ChatAttentionNoticeRequest[] =>
      readFileSync(file, 'utf8')
        .split('\n')
        .filter(line => line.startsWith('{'))
        .map(line => JSON.parse(line) as ChatAttentionNoticeRequest);
    const stale = await pause(gate('stale'));
    const host = createChatHost(
      [
        {
          descriptor,
          argv: [process.execPath, `${import.meta.dir}/fixtures/plugin.ts`, 'attention', file],
        },
      ],
      {},
      new ConversationLockManager(),
      new Map(),
      [],
      { routes, inlinePlatforms: new Set() }
    );
    const [route, missing] = host.attentionDestinations;
    await Promise.all(host.attentionDestinations.map(destination => destination.activate()));
    host.start();
    try {
      const deadline = Date.now() + testTimeout(5000);
      while ((await route.state()) !== 'active') {
        if (Date.now() > deadline) throw new Error('Chat plugin did not become live');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const router = new AttentionRouter(host.attentionDestinations, new Set());
      await router.scan();
      expect(received()).toEqual([]);
      expect((await listAttentionNotices([stale])).map(row => row.data)).toEqual([
        { destination: 'fixture-chat:ops', key: 'review:stale', baseline: true },
      ]);
      expect(router.health()).toEqual([
        { id: 'fixture-chat:ops', state: 'active' },
        { id: 'missing-chat:ops', state: 'misconfigured' },
      ]);

      const gated = await pause(gate('first'));
      const waiting = await pause({
        wait: {
          kind: 'attention',
          owner: 'node',
          nodeId: 'hold',
          waitingSince: '2026-10-13T01:00:00.000Z',
          message: 'Pick a base',
          pauseId: 'w1',
          form: 'select',
          options: [{ id: 'use-main' }, { id: 'use-dev', label: 'Dev' }],
        },
      });
      await Promise.all([router.scan(), router.scan()]);
      await router.scan();
      await new AttentionRouter(host.attentionDestinations, new Set()).scan();
      const opened = received();
      expect(opened.map(request => request.notice)).toEqual(
        expect.arrayContaining([
          {
            type: 'gate',
            runId: gated,
            workflowName: 'nightly',
            nodeId: 'review',
            pauseId: 'first',
            gateType: 'approval',
            message: 'Ship it?',
            decisions: [{ id: 'ship', label: 'Ship' }, { id: 'rework' }],
          },
          {
            type: 'attention',
            runId: waiting,
            workflowName: 'nightly',
            nodeId: 'hold',
            pauseId: 'w1',
            message: 'Pick a base',
            form: 'select',
            options: [{ id: 'use-main' }, { id: 'use-dev', label: 'Dev' }],
          },
        ])
      );
      expect(opened.length).toBe(2);
      expect(opened.every(request => request.destination === 'ops')).toBe(true);
      expect(opened.some(request => request.conversationId !== undefined)).toBe(false);

      await setRun(gated, 'paused', gate('second'));
      await router.scan();
      await router.scan();
      expect(received().length).toBe(3);
      const rows = await listAttentionNotices([gated]);
      expect(rows.map(row => row.data.destination)).toEqual([
        'fixture-chat:ops',
        'fixture-chat:ops',
      ]);
      const threadOfSecond = rows[1]?.data.conversationId;
      expect(threadOfSecond).toMatch(/^thread-\d+$/);

      await setRun(gated, 'completed', { total_cost_usd: 0.5 });
      await router.scan();
      await router.scan();
      const all = received();
      expect(all.length).toBe(4);
      expect(all[3]).toEqual({
        destination: 'ops',
        conversationId: threadOfSecond,
        notice: {
          type: 'terminal',
          runId: gated,
          workflowName: 'nightly',
          status: 'completed',
          totalCostUsd: 0.5,
        },
      });
      expect((await listAttentionNotices([gated])).length).toBe(3);

      // A restart re-activates the route; once it has ledger rows, a gate opened while the
      // server was down is sent, not baselined.
      const openedWhileDown = await pause(gate('while-down'));
      await route.activate();
      await router.scan();
      expect(received().length).toBe(5);
      expect((await listAttentionNotices([openedWhileDown])).map(row => row.data)).toEqual([
        {
          destination: 'fixture-chat:ops',
          key: 'review:while-down',
          conversationId: expect.any(String),
        },
      ]);
      expect(await missing.state()).toBe('misconfigured');
    } finally {
      await host.stop();
    }
  },
  testTimeout(15000)
);

test('a route whose plugin lacks the capability is misconfigured and activation writes nothing', async () => {
  const stale = await pause(gate('stale'));
  const { attentionDestinations } = createChatHost(
    [
      {
        descriptor: {
          ...descriptor,
          capabilities: { defaultWorkflowDispatch: 'foreground' },
        },
        argv: [process.execPath],
      },
    ],
    {},
    new ConversationLockManager(),
    new Map(),
    [],
    { routes: routes.slice(0, 1), inlinePlatforms: new Set() }
  );
  const [route] = attentionDestinations;
  await route.activate();
  expect(await route.state()).toBe('misconfigured');
  expect(await listAttentionNotices([stale])).toEqual([]);
});
