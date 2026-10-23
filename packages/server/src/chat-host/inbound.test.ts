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
import { resumeRefusal } from '@archon/workflows/resource-start-store';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { descriptor } from './fixtures/descriptor';
import { ChatPluginPlatform } from './platform';

const handleMessage = mock(async (..._args: unknown[]) => {});
mock.module('@archon/core', () => ({
  handleMessage,
  classifyAndFormatError: () => 'Message processing failed',
}));
const resume = mock(async (..._args: unknown[]) => ({ kind: 'resumed' }));
const target = { kind: 'unavailable', reason: 'test destination' };
mock.module('../services/workflow-resume-service', () => ({
  workflowResumeTargetForRun: async () => target,
  resumeWorkflowRunFromServer: resume,
}));
const { registerChatInbound } = await import('./inbound');
/** A resume refused for capacity, with the refusal the store derives from the run's state. */
const refuseForCapacity = (): void => {
  resume.mockImplementationOnce(async (_host: unknown, run: unknown) => ({
    kind:
      resumeRefusal(run as WorkflowRun, undefined) === 'waiting'
        ? 'waiting_for_capacity'
        : 'resource_busy',
    message: 'busy',
  }));
};

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
  attentionNotice: async () => ({}),
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
    ).toEqual({
      status: 'done',
      result: {
        kind: 'cooperative',
        cancelled: true,
        // Cooperative cancellation reports possible host-command leftovers only on POSIX hosts.
        ...(process.platform === 'win32'
          ? {}
          : { cleanupWarnings: [expect.stringContaining('untracked background work')] }),
      },
    });
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
  ).toEqual({
    status: 'refused',
    message: expect.stringContaining("It is now awaiting occurrence 'pause-1'"),
  });
  expect(resume).not.toHaveBeenCalled();
  expect(
    await action({
      runId: paused.id,
      action: 'approve',
      response: { nodeId: 'gate', pauseId: 'pause-1' },
      sender: { platformUserId: 'starter' },
    })
  ).toEqual({ status: 'done', result: { kind: 'approved', type: 'approval_gate', resumed: true } });
  // A chat-plugin answer records the plugin's own id as the surface it came through.
  expect((await getWorkflowRun(paused.id))?.metadata.approval).toMatchObject({
    answeredVia: descriptor.id,
  });
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
  expect((await getWorkflowRun(custom.id))?.metadata.approval).toMatchObject({
    answeredVia: descriptor.id,
  });
});

test('reject cancels an approval gate without resuming the run', async () => {
  const paused = await run(true);
  expect(
    await action({
      runId: paused.id,
      action: 'reject',
      response: { nodeId: 'gate', pauseId: 'pause-1' },
      sender: { platformUserId: 'starter' },
    })
  ).toMatchObject({
    status: 'done',
    result: { kind: 'rejected', cancelled: true, resumed: false },
  });
  expect((await getWorkflowRun(paused.id))?.status).toBe('cancelled');
  expect(resume).not.toHaveBeenCalled();
});

async function waiting(wait: Record<string, unknown>) {
  const started = await run();
  await getDatabase().query(
    "UPDATE remote_agent_workflow_runs SET status = 'paused', metadata = $1 WHERE id = $2",
    [
      JSON.stringify({
        wait: {
          kind: 'attention',
          owner: 'node',
          nodeId: 'hold',
          waitingSince: '2026-10-13T01:00:00.000Z',
          message: 'Pick a base',
          ...wait,
        },
      }),
      started.id,
    ]
  );
  return started.id;
}
const select = {
  pauseId: 'w1',
  form: 'select',
  options: [{ id: 'use-main' }, { id: 'use-dev' }],
};
const waitOf = async (runId: string) => (await getWorkflowRun(runId))?.metadata.wait;

test('a typed answer is authorized, names its occurrence, records the surface and resumes', async () => {
  const runId = await waiting(select);
  const answer = (platformUserId: string, pauseId: string, choose: string[]) =>
    action({
      runId,
      action: 'answer',
      response: { nodeId: 'hold', pauseId, choose },
      sender: { platformUserId },
    });
  expect(await answer('other', 'w1', ['use-main'])).toMatchObject({ status: 'forbidden' });
  // A stale occurrence is still forbidden, so the refusal never names the live one.
  const forbiddenStale = await answer('other', 'w0', ['use-main']);
  expect(forbiddenStale).toMatchObject({ status: 'forbidden' });
  expect(JSON.stringify(forbiddenStale)).not.toContain('w1');
  expect(await answer('starter', 'w0', ['use-main'])).toEqual({
    status: 'refused',
    message: expect.stringContaining("It is now awaiting occurrence 'w1'"),
  });
  expect(await answer('starter', 'w1', ['use-elsewhere'])).toEqual({
    status: 'refused',
    message: expect.stringContaining("does not declare option 'use-elsewhere'"),
  });
  expect(await waitOf(runId)).not.toHaveProperty('answer');
  expect(resume).not.toHaveBeenCalled();
  expect(await answer('starter', 'w1', ['use-dev'])).toEqual({
    status: 'done',
    result: { kind: 'answered', resumed: true },
  });
  expect(await waitOf(runId)).toMatchObject({
    answer: { decision: 'use-dev' },
    answeredVia: descriptor.id,
  });
  expect(resume.mock.calls[0]?.[2]).toBe(userId);
});

test('resume continues a wait paused before answers, and refuses an unanswered form', async () => {
  const legacy = await waiting({});
  expect(
    await action({ runId: legacy, action: 'resume', sender: { platformUserId: 'other' } })
  ).toMatchObject({ status: 'forbidden' });
  expect(
    await action({ runId: legacy, action: 'resume', sender: { platformUserId: 'starter' } })
  ).toEqual({ status: 'done', result: { kind: 'resumed', resumed: true } });
  expect(resume.mock.calls[0]?.[2]).toBe(userId);
  const unanswered = await waiting(select);
  expect(
    await action({ runId: unanswered, action: 'resume', sender: { platformUserId: 'starter' } })
  ).toEqual({
    status: 'refused',
    message: expect.stringContaining("waiting for an answer to its 'select' attention wait"),
  });
  expect(resume).toHaveBeenCalledTimes(1);
});

test('a resume refused for capacity reports a wait only for a run that keeps its place', async () => {
  const resumeAs = (runId: string) =>
    action({ runId, action: 'resume', sender: { platformUserId: 'starter' } });
  // An early resume of a pause that is not ready holds no place.
  const notReady = await waiting({});
  refuseForCapacity();
  expect(await resumeAs(notReady)).toEqual({
    status: 'done',
    result: { kind: 'resumed', resumed: false },
  });
  const failed = await run();
  await getDatabase().query(
    "UPDATE remote_agent_workflow_runs SET status = 'failed' WHERE id = $1",
    [failed.id]
  );
  refuseForCapacity();
  expect(await resumeAs(failed.id)).toEqual({
    status: 'done',
    result: { kind: 'resumed', resumed: false },
  });
  const answered = await waiting(select);
  refuseForCapacity();
  expect(
    await action({
      runId: answered,
      action: 'answer',
      response: { nodeId: 'hold', pauseId: 'w1', choose: ['use-dev'] },
      sender: { platformUserId: 'starter' },
    })
  ).toEqual({
    status: 'done',
    result: { kind: 'answered', resumed: false, waitingForCapacity: true },
  });
  refuseForCapacity();
  expect(await resumeAs(answered)).toEqual({
    status: 'done',
    result: { kind: 'resumed', resumed: false, waitingForCapacity: true },
  });
  expect(resume).toHaveBeenCalledTimes(4);
});

test('a failed resume reports the recorded approval as not resumed, not refused', async () => {
  const paused = await run(true);
  resume.mockImplementationOnce(async () => {
    throw new Error('resume failed');
  });
  expect(
    await action({ runId: paused.id, action: 'approve', sender: { platformUserId: 'starter' } })
  ).toEqual({
    status: 'done',
    result: { kind: 'approved', type: 'approval_gate', resumed: false },
  });
  expect((await getWorkflowRun(paused.id))?.metadata).toMatchObject({
    approval: { resolved: 'approved' },
  });
});

test('an approval refused for capacity reports the run as waiting, not refused', async () => {
  const paused = await run(true);
  refuseForCapacity();
  expect(
    await action({ runId: paused.id, action: 'approve', sender: { platformUserId: 'starter' } })
  ).toEqual({
    status: 'done',
    result: {
      kind: 'approved',
      type: 'approval_gate',
      resumed: false,
      waitingForCapacity: true,
    },
  });
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
      request: async operation => {
        await send();
        return operation(connection);
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

test.each(['approve', 'reject'] as const)(
  'blocked parent %s redirects with the configured spelling',
  async decision => {
    const parent = await run();
    await pauseWorkflowRun(parent.id, {
      nodeId: 'sub',
      pauseId: 'child-pause',
      type: 'child_workflow',
      childRunId: 'child-full-id',
      message: 'Waiting',
    });
    const response = await action({
      runId: parent.id,
      action: decision,
      response: { nodeId: 'sub', pauseId: 'child-pause' },
      sender: { platformUserId: 'starter' },
    });
    expect(response).toMatchObject({
      status: 'refused',
      message: expect.stringContaining(`/fixture-workflow ${decision} child-full-id`),
    });
    expect(resume).not.toHaveBeenCalled();
    expect((await getWorkflowRun(parent.id))?.metadata.approval).not.toHaveProperty('resolved');
  }
);
