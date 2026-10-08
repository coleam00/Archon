import { beforeEach, afterEach, expect, mock, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import type { ChatActor, ConnectedChat } from '@archon/chat-contract';
import type { RunActor } from '@archon/core/operations/run-authorization';
import { ConversationLockManager } from '@archon/core/utils/conversation-lock';
import { closeDatabase, getDatabase, resetDatabase } from '@archon/core/db/connection';
import { findOrCreateUserByPlatformIdentity, setUserRole } from '@archon/core/db/users';
import { createWorkflowRun, getWorkflowRun, pauseWorkflowRun } from '@archon/core/db/workflows';
import { startRunLiveOwner } from '@archon/core/services/run-live-owner';
import { descriptor } from './fixtures/descriptor';
import { ChatPluginPlatform } from './platform';

const handleMessage = mock(async (..._args: unknown[]) => {});
mock.module('@archon/core', () => ({
  handleMessage,
  classifyAndFormatError: () => 'Message processing failed',
}));
const resume = mock(async (..._args: unknown[]) => true);
const target = { kind: 'unavailable', reason: 'test destination' };
mock.module('../services/workflow-resume-service', () => ({
  workflowResumeTargetForRun: async () => target,
  resumeWorkflowRunFromServer: resume,
}));
const { registerChatInbound } = await import('./inbound');

let inbound: Parameters<ConnectedChat['onInbound']>[0];
let action: Parameters<ConnectedChat['onRunAction']>[0];
const connection: ConnectedChat = {
  descriptor,
  closed: Promise.resolve(),
  start: async () => {},
  close: async () => {},
  send: async () => {},
  resultFooter: async () => {},
  runEvent: async () => {},
  onInbound: handler => {
    inbound = handler;
  },
  onRunAction: handler => {
    action = handler;
  },
};
const platform = new ChatPluginPlatform(
  descriptor,
  { request: operation => operation(connection) },
  {}
);
const platforms = new Map([[descriptor.id, platform]]);
const originalEnv = {
  home: process.env.ARCHON_HOME,
  database: process.env.DATABASE_URL,
  allowed: process.env.FIXTURE_ALLOWED_USERS,
};
let root: string;
let conversationId: string;
let userId: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'chat-inbound-'));
  process.env.ARCHON_HOME = root;
  delete process.env.DATABASE_URL;
  process.env.FIXTURE_ALLOWED_USERS = 'starter, other, admin';
  resetDatabase();
  handleMessage.mockClear();
  resume.mockClear();
  userId = (await findOrCreateUserByPlatformIdentity(descriptor.id, 'starter')).id;
  conversationId = crypto.randomUUID();
  await getDatabase().query(
    `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id) VALUES ($1, $2, 'thread-1')`,
    [conversationId, descriptor.id]
  );
  registerChatInbound(connection, descriptor, platform, new ConversationLockManager(), platforms);
});
afterEach(async () => {
  await closeDatabase();
  for (const [key, value] of [
    ['ARCHON_HOME', originalEnv.home],
    ['DATABASE_URL', originalEnv.database],
    ['FIXTURE_ALLOWED_USERS', originalEnv.allowed],
  ]) {
    if (value === undefined) delete process.env[key!];
    else process.env[key!] = value;
  }
  await removeTempTree(root);
});
async function run(paused = false) {
  const run = await createWorkflowRun({
    workflow_name: 'fixture',
    origin: { conversationId, userId },
    user_message: 'private message',
    working_path: root,
  });
  await getDatabase().query(
    "UPDATE remote_agent_workflow_runs SET status = 'running' WHERE id = $1",
    [run.id]
  );
  if (paused)
    await pauseWorkflowRun(run.id, { nodeId: 'gate', message: 'Review', pauseId: 'pause-1' });
  return run;
}

test('only allowlisted traffic resolves identity and dispatches through the conversation lock', async () => {
  const count = async () =>
    (
      await getDatabase().query<{ count: number }>(
        'SELECT COUNT(*) AS count FROM remote_agent_users'
      )
    ).rows[0]?.count;
  const before = await count();
  expect(
    await inbound({
      conversationId: 'thread-1',
      text: 'private message',
      sender: { platformUserId: 'blocked' },
    })
  ).toEqual({ status: 'rejected', reason: 'not_allowed' });
  expect(
    await action({
      runId: 'does-not-exist',
      action: 'cancel',
      sender: { platformUserId: 'blocked' },
    })
  ).toEqual({ status: 'rejected', reason: 'not_allowed' });
  expect(await count()).toBe(before);
  expect(handleMessage).not.toHaveBeenCalled();
  expect(
    await inbound({
      conversationId: 'thread-1',
      parentConversationId: 'parent',
      threadContext: 'history',
      text: 'private message',
      sender: { platformUserId: 'starter' },
    })
  ).toEqual({ status: 'accepted' });
  expect(handleMessage).toHaveBeenCalledWith(platform, 'thread-1', 'private message', {
    parentConversationId: 'parent',
    threadContext: 'history',
    isolationHints: { workflowType: 'thread', workflowId: 'thread-1' },
    actor: { kind: 'user', userId },
  });
});

test('starter cancel succeeds; another member is forbidden; admins can act', async () => {
  const started = await run();
  const owner = await startRunLiveOwner(started.id);
  try {
    expect(
      await action({ runId: started.id, action: 'cancel', sender: { platformUserId: 'other' } })
    ).toMatchObject({ status: 'forbidden' });
    expect((await getWorkflowRun(started.id))?.status).toBe('running');
    expect(
      await action({ runId: started.id, action: 'cancel', sender: { platformUserId: 'starter' } })
    ).toEqual({ status: 'done', result: { kind: 'cooperative', cancelled: true } });
  } finally {
    await owner.close();
  }
  const admin = await findOrCreateUserByPlatformIdentity(descriptor.id, 'admin');
  await setUserRole(admin.id, 'admin');
  const paused = await run(true);
  expect(
    await action({ runId: paused.id, action: 'approve', sender: { platformUserId: 'admin' } })
  ).toMatchObject({ status: 'done', result: { resumed: true } });
});

test('approve and declared response preserve gate occurrence and resume with host identity', async () => {
  const paused = await run(true);
  expect(
    await action({ runId: paused.id, action: 'approve', sender: { platformUserId: 'other' } })
  ).toMatchObject({ status: 'forbidden' });
  expect(resume).not.toHaveBeenCalled();
  expect(
    await action({
      runId: paused.id,
      action: 'approve',
      response: { nodeId: 'gate', pauseId: 'wrong' },
      sender: { platformUserId: 'starter' },
    })
  ).toMatchObject({ status: 'refused' });
  expect(resume).not.toHaveBeenCalled();
  expect(
    await action({
      runId: paused.id,
      action: 'approve',
      response: { nodeId: 'gate', pauseId: 'pause-1' },
      sender: { platformUserId: 'starter' },
    })
  ).toEqual({ status: 'done', result: { kind: 'approved', type: 'approval_gate', resumed: true } });
  expect(resume.mock.calls[0]?.[2]).toBe(userId);
  expect(resume.mock.calls[0]?.[3]).toBe(target);
  const custom = await run();
  await pauseWorkflowRun(custom.id, {
    nodeId: 'gate',
    message: 'Review',
    decisionsAuthored: true,
    decisions: [{ id: 'ship' }],
  });
  expect(
    await action({
      runId: custom.id,
      action: 'respond',
      response: { decision: 'ship', nodeId: 'gate' },
      sender: { platformUserId: 'starter' },
    })
  ).toMatchObject({ status: 'done', result: { kind: 'approved', resumed: true } });
});

test('cancel without a live owner carries an explicit abandon hint', async () => {
  const started = await run();
  expect(
    await action({ runId: started.id, action: 'cancel', sender: { platformUserId: 'starter' } })
  ).toMatchObject({
    status: 'refused',
    abandonHint: expect.stringContaining(`/fixture-workflow abandon ${started.id}`),
  });
  expect((await getWorkflowRun(started.id))?.status).toBe('running');
});

test('message failures send an error reply despite the lock swallowing handler failures', async () => {
  const send = mock(async () => {});
  const failedPlatform = new ChatPluginPlatform(
    descriptor,
    {
      request: async () => {
        await send();
      },
    },
    {}
  );
  registerChatInbound(
    connection,
    descriptor,
    failedPlatform,
    new ConversationLockManager(),
    platforms
  );
  handleMessage.mockRejectedValueOnce(new Error('PRIVATE_USER_MESSAGE'));
  await inbound({
    conversationId: 'thread-1',
    text: 'private message',
    sender: { platformUserId: 'starter' },
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(send).toHaveBeenCalledTimes(1);
});

// The core actor is deliberately wider than identities a chat plugin can assert.
const operator: RunActor = { kind: 'operator' };
// @ts-expect-error An operator cannot cross the chat identity boundary.
const chatActor: ChatActor = operator;
void chatActor;
