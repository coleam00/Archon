// @archon-test-isolated
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { providerRegistry } from '@archon/providers';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import { InProcessWorkflowEngine } from '@archon/workflows/in-process-engine';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { loadConfig } from '../../config/config-loader';
import { setPlatformPolicies } from '../../platforms/registry';
import { closeDatabase, getDatabase, resetDatabase } from '../../db/connection';
import { createWorkflowDeps } from '../../workflows/store-adapter';
import { createSqlWorkflowOperations } from '../../workflows/sql-host';
import type { IPlatformAdapter } from '../../types';
import { dispatchBackgroundWorkflow } from './background';

const WORKFLOW = `name: bg-pause
description: pauses twice in a background run
worktree:
  enabled: false
nodes:
  - id: before
    bash: echo before
  - id: review
    depends_on: [before]
    approval:
      message: Approve the plan?
  - id: ask
    depends_on: [review]
    wait:
      attention: Anything else?
  - id: after
    depends_on: [ask]
    bash: echo after >> after-count
`;

const originalHome = process.env.ARCHON_HOME;
const originalDatabaseUrl = process.env.DATABASE_URL;
let root: string;

beforeEach(async () => {
  registerBuiltinProviders();
  setPlatformPolicies([]);
  root = await realpath(await mkdtemp(join(tmpdir(), 'archon-bg-pause-')));
  process.env.ARCHON_HOME = join(root, 'home');
  // The dispatch records a provider on the worker conversation; no node calls it.
  await mkdir(process.env.ARCHON_HOME, { recursive: true });
  await writeFile(join(process.env.ARCHON_HOME, 'config.yaml'), 'defaultAssistant: claude\n');
  delete process.env.DATABASE_URL;
  resetDatabase();
});

afterEach(async () => {
  await closeDatabase();
  if (originalHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalHome;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  await removeTempTree(root);
});

function webPlatform(): IPlatformAdapter {
  return {
    capabilities: { messagePersistence: 'adapter', defaultWorkflowDispatch: 'background' },
    sendMessage: mock(async () => {}),
    ensureThread: async id => id,
    getStreamingMode: () => 'batch',
    getPlatformType: () => 'web',
    start: async () => {},
    stop: () => {},
  };
}

async function waitForStatus(runId: string, status: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  const store = createWorkflowDeps().store;
  while (Date.now() < deadline) {
    if ((await store.getWorkflowRunStatus(runId)) === status) return;
    await Bun.sleep(25);
  }
  throw new Error(`run ${runId} never reached ${status}`);
}

test('a background dispatch pauses at a gate and an attention wait and continues after each answer', async () => {
  const project = join(root, 'project');
  await mkdir(join(project, '.archon', 'workflows'), { recursive: true });
  await writeFile(join(project, '.archon', 'workflows', 'bg-pause.yaml'), WORKFLOW);
  const parent = crypto.randomUUID();
  await getDatabase().query(
    `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
     VALUES ($1, 'web', $1)`,
    [parent]
  );
  const { workflows } = await discoverWorkflowsWithConfig(project, loadConfig, providerRegistry);
  const workflow = workflows.find(entry => entry.workflow.name === 'bg-pause')?.workflow;
  if (!workflow) throw new Error('fixture workflow did not load');
  const platform = webPlatform();

  await dispatchBackgroundWorkflow(
    {
      platform,
      conversationId: parent,
      cwd: project,
      originalMessage: 'go',
      conversationDbId: parent,
      availableWorkflows: [workflow],
    },
    workflow
  );

  const { rows } = await getDatabase().query<{ id: string }>(
    "SELECT id FROM remote_agent_workflow_runs WHERE workflow_name = 'bg-pause'"
  );
  const runId = rows[0]?.id;
  if (!runId) throw new Error('background dispatch created no run');
  const deps = createWorkflowDeps();
  const { approveWorkflow } = createSqlWorkflowOperations();
  const answerAndContinue = async (answer: string): Promise<void> => {
    await approveWorkflow(runId, answer, { kind: 'operator' }, { via: 'cli' });
    const run = await deps.store.getWorkflowRun(runId);
    if (!run) throw new Error('run disappeared');
    const admission = await new InProcessWorkflowEngine(deps).resume({
      run,
      platform,
      conversationId: parent,
      cwd: project,
      userMessage: 'go',
    });
    if (!admission.accepted) throw new Error('resume was not accepted');
    await admission.settled;
  };

  await waitForStatus(runId, 'paused');
  expect((await deps.store.getWorkflowRun(runId))?.metadata.approval).toMatchObject({
    nodeId: 'review',
  });

  await answerAndContinue('looks good');
  expect(await deps.store.getWorkflowRunStatus(runId)).toBe('paused');
  expect((await deps.store.getWorkflowRun(runId))?.metadata.wait).toMatchObject({
    kind: 'attention',
    nodeId: 'ask',
  });

  await answerAndContinue('nothing else');
  expect(await deps.store.getWorkflowRunStatus(runId)).toBe('completed');
  expect(await readFile(join(project, 'after-count'), 'utf8')).toBe('after\n');
}, 60_000);
