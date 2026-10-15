// @archon-test-isolated
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { clearRegistry, getRegistration, registerProvider } from '@archon/providers/registry';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import { CodexProvider } from '@archon/providers/codex/provider';
import * as binaryResolver from '@archon/providers/codex/binary-resolver';
import {
  createFakeAppServer,
  THREAD_ID,
  TURN_ID,
} from '../../../providers/src/test/codex-app-server-fake';
import { closeDatabase, getDatabase, resetDatabase } from '../db/connection';
import { createCodebase } from '../db/codebases';
import { getOrCreateConversation, updateConversationTitle } from '../db/conversations';
import { setPlatformPolicies } from '../platforms/registry';
import type { IPlatformAdapter } from '../types';
import { handleMessage } from './orchestrator-agent';

const originalHome = process.env.ARCHON_HOME;
const originalDatabaseUrl = process.env.DATABASE_URL;
let root: string | undefined;

afterEach(async () => {
  await closeDatabase();
  if (originalHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalHome;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  clearRegistry();
  if (root) await removeTempTree(root);
});

test('Codex chat launches a persisted workflow through the typed tool and real dispatch', async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'archon-codex-launch-')));
  process.env.ARCHON_HOME = join(root, 'home');
  delete process.env.DATABASE_URL;
  resetDatabase();
  setPlatformPolicies([]);
  await mkdir(process.env.ARCHON_HOME, { recursive: true });
  await writeFile(join(process.env.ARCHON_HOME, 'config.yaml'), 'defaultAssistant: codex\n');
  const project = join(root, 'project');
  await mkdir(join(project, '.archon', 'workflows'), { recursive: true });
  await writeFile(
    join(project, '.archon', 'workflows', 'chat-launch.yaml'),
    `name: chat-launch
description: Harmless launch proof
worktree:
  enabled: false
nodes:
  - id: review
    wait:
      attention: Launch reached the engine
`
  );
  registerBuiltinProviders();
  const registration = getRegistration('codex');
  clearRegistry();
  const server = createFakeAppServer(() => ({
    toolCalls: [
      {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        callId: 'launch',
        namespace: null,
        tool: 'invoke_workflow',
        arguments: {
          workflow: 'chat-launch',
          project: 'fixture',
          prompt: 'start the harmless workflow',
        },
      },
    ],
  }));
  registerProvider({ ...registration, factory: () => new CodexProvider(server, 1) });
  const resolveBinary = spyOn(binaryResolver, 'resolveCodexBinaryPath').mockResolvedValue(
    '/fixture/codex'
  );
  const codebase = await createCodebase({
    name: 'fixture',
    kind: 'folder',
    default_cwd: project,
    ai_assistant_type: 'codex',
  });
  const conversationId = crypto.randomUUID();
  const conversation = await getOrCreateConversation('web', conversationId, codebase.id);
  await updateConversationTitle(conversation.id, 'Launch proof');
  const backgroundDone = Promise.withResolvers<void>();
  const platform: IPlatformAdapter = {
    capabilities: { messagePersistence: 'adapter', defaultWorkflowDispatch: 'background' },
    sendMessage: async () => {},
    prepareBackgroundConversation: async () => async () => {
      backgroundDone.resolve();
    },
    ensureThread: async id => id,
    getStreamingMode: () => 'batch',
    getPlatformType: () => 'web',
    start: async () => {},
    stop: () => {},
  };
  try {
    await handleMessage(platform, conversationId, 'Launch the harmless workflow', {
      actor: { kind: 'operator' },
    });
    expect(server.processes[0].toolResponses[0].result.success).toBe(true);
    const { rows } = await getDatabase().query<{ id: string; parent_conversation_id: string }>(
      "SELECT id, parent_conversation_id FROM remote_agent_workflow_runs WHERE workflow_name = 'chat-launch'"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].parent_conversation_id).toBe(conversation.id);
    await backgroundDone.promise;
    const { getWorkflowRun } = await import('../db/workflows');
    const run = await getWorkflowRun(rows[0].id);
    expect(run?.status).toBe('paused');
    expect(run?.metadata.wait).toMatchObject({ kind: 'attention', nodeId: 'review' });
  } finally {
    resolveBinary.mockRestore();
  }
});
