// @archon-test-isolated
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeTempTree } from '@archon/paths/test-utils';
import type { MessageChunk } from '@archon/provider-contract';
import { getProviderCapabilities, providerRegistry } from '@archon/providers';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import type { IWorkflowPlatform, WorkflowDeps } from '@archon/workflows/deps';
import { InProcessWorkflowEngine } from '@archon/workflows/in-process-engine';
import { RUN_STOP_REASON_METADATA_KEY } from '@archon/workflows/schemas/workflow-run';
import { makeTestResolvedWorkflow } from '@archon/workflows/test-utils';
import { closeDatabase, getDatabase, resetDatabase } from '../db/connection';
import { wakeDueWorkflowContinuations } from './continuation-resume';
import { createWorkflowStore } from './store-adapter';

const originalHome = process.env.ARCHON_HOME;
const originalDatabaseUrl = process.env.DATABASE_URL;
let root: string;
let conversationId: string;

beforeEach(async () => {
  registerBuiltinProviders();
  root = await mkdtemp(join(tmpdir(), 'archon-usage-limit-wait-'));
  process.env.ARCHON_HOME = root;
  delete process.env.DATABASE_URL;
  resetDatabase();
  conversationId = crypto.randomUUID();
  await getDatabase().query(
    `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
     VALUES ($1, 'test', $1)`,
    [conversationId]
  );
});

afterEach(async () => {
  await closeDatabase();
  if (originalHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalHome;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  await removeTempTree(root);
});

const platform: IWorkflowPlatform = {
  sendMessage: async () => {},
  getPlatformType: () => 'test',
  getStreamingMode: () => 'batch',
};
const workflow = makeTestResolvedWorkflow({
  name: 'usage-limit',
  nodes: [{ id: 'implement', prompt: 'Implement it' }],
});

/**
 * A provider whose turns play `turns` in order: a usage limit with a reset, a rate limit
 * (with a reset when one is given), or success.
 */
function harness(turns: ({ resetAt?: string; rateLimited?: true } | 'ok')[]): {
  engine: InProcessWorkflowEngine;
  store: WorkflowDeps['store'];
  calls: () => number;
} {
  let calls = 0;
  const store = createWorkflowStore();
  const deps: WorkflowDeps = {
    store,
    providers: providerRegistry,
    getAgentProvider: () => ({
      getType: () => 'claude',
      getCapabilities: () => getProviderCapabilities('claude'),
      checkCredential: async () => ({ state: 'not_checked', source: 'native' }),
      sendQuery: async function* (): AsyncGenerator<MessageChunk> {
        const turn = turns[calls++];
        if (turn === 'ok') {
          yield { type: 'agent_message_chunk', text: 'done' };
          yield { type: 'result', sessionId: `session-${String(calls)}` };
        } else {
          yield {
            type: 'result',
            isError: true,
            sessionId: `session-${String(calls)}`,
            failure: {
              ...(turn?.rateLimited
                ? { class: 'rate_limited' as const, evidence: 'HTTP 429' }
                : { class: 'quota_exhausted' as const, evidence: "You've hit your session limit" }),
              ...(turn?.resetAt !== undefined ? { resetAt: turn.resetAt } : {}),
            },
          };
        }
        yield { type: 'settled' };
      },
    }),
    loadConfig: async () => ({
      assistant: 'claude',
      baseBranch: 'main',
      assistants: { claude: {}, codex: {} },
      commands: {},
      defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
      workflows: { autoResumeOnQuotaReset: true },
    }),
  };
  return { engine: new InProcessWorkflowEngine(deps), store, calls: () => calls };
}

async function submit(
  engine: InProcessWorkflowEngine,
  submitted: typeof workflow = workflow
): Promise<string> {
  const result = await engine.submit({
    platform,
    conversationId,
    origin: { conversationId },
    cwd: root,
    userMessage: 'goal',
    workflow: submitted,
  });
  if (!result.workflowRunId) throw new Error('submit created no run');
  return result.workflowRunId;
}

/** One continuation host pass at `now`, continuing every due run through the engine. */
async function wake(
  engine: InProcessWorkflowEngine,
  store: WorkflowDeps['store'],
  now: Date,
  continued: typeof workflow = workflow
): Promise<string[]> {
  const settled: Promise<unknown>[] = [];
  const outcomes = await wakeDueWorkflowContinuations(store, now, async (run, cursor) => {
    const admission = await engine.resume({
      run,
      platform,
      conversationId,
      cwd: root,
      userMessage: run.user_message,
      legacyWorkflow: continued,
      cursor,
    });
    if (!admission.accepted) return { kind: 'not-accepted' };
    settled.push(admission.settled);
    return { kind: 'accepted', run, settled: admission.settled };
  });
  await Promise.all(settled);
  return outcomes.filter(outcome => outcome.kind === 'accepted').map(outcome => outcome.runId);
}

test('a typed usage limit with a reset waits, then the continuation host continues the run after the reset', async () => {
  const resetAt = new Date(Date.now() + 3_600_000).toISOString();
  const { engine, store, calls } = harness([{ resetAt }, 'ok']);

  const runId = await submit(engine);
  const waiting = await store.getWorkflowRun(runId);
  expect(waiting?.status).toBe('paused');
  expect(waiting?.metadata.wait).toMatchObject({
    kind: 'quota',
    nodeId: 'implement',
    resumeAt: resetAt,
  });

  // Nothing is due before the reset: one continuation, at the reset time.
  expect(await wake(engine, store, new Date(Date.parse(resetAt) - 1000))).toEqual([]);
  expect(calls()).toBe(1);

  expect(await wake(engine, store, new Date(Date.parse(resetAt) + 1000))).toEqual([runId]);
  const finished = await store.getWorkflowRun(runId);
  expect(finished?.status).toBe('completed');
  expect(finished?.metadata.wait).toBeUndefined();
  expect(calls()).toBe(2);
});

test('a repeat usage limit after the continuation waits again, on the new reset', async () => {
  const firstReset = new Date(Date.now() + 3_600_000).toISOString();
  const secondReset = new Date(Date.now() + 7_200_000).toISOString();
  const { engine, store } = harness([{ resetAt: firstReset }, { resetAt: secondReset }, 'ok']);

  const runId = await submit(engine);
  expect(await wake(engine, store, new Date(Date.parse(firstReset) + 1000))).toEqual([runId]);
  const again = await store.getWorkflowRun(runId);
  expect(again?.status).toBe('paused');
  expect(again?.metadata.wait).toMatchObject({ kind: 'quota', resumeAt: secondReset });
  expect(await wake(engine, store, new Date(Date.parse(firstReset) + 2000))).toEqual([]);

  expect(await wake(engine, store, new Date(Date.parse(secondReset) + 1000))).toEqual([runId]);
  expect(await store.getWorkflowRunStatus(runId)).toBe('completed');
});

test('a typed usage limit without a reset still fails the run', async () => {
  const { engine, store } = harness([{}]);

  const runId = await submit(engine);
  const failed = await store.getWorkflowRun(runId);
  expect(failed?.status).toBe('failed');
  expect(failed?.metadata.wait).toBeUndefined();
  expect(await wake(engine, store, new Date(Date.now() + 86_400_000))).toEqual([]);
});

test('a rejected quota pause write fails the run without leaving a durable wait', async () => {
  const resetAt = new Date(Date.now() + 3_600_000).toISOString();
  const { engine, store, calls } = harness([{ resetAt }]);
  const pause = spyOn(store, 'pauseWorkflowRunForWait').mockRejectedValue(
    new Error('quota pause write failed')
  );
  try {
    const runId = await submit(engine);
    expect(pause).toHaveBeenCalledWith(
      runId,
      expect.objectContaining({ kind: 'quota', resumeAt: resetAt }),
      { kind: 'started', stepName: 'implement' }
    );
    const failed = await store.getWorkflowRun(runId);
    expect(failed?.status).toBe('failed');
    expect(failed?.metadata.error).toBe('quota pause write failed');
    expect(failed?.metadata.wait).toBeUndefined();
    expect(await wake(engine, store, new Date(Date.parse(resetAt) + 1000))).toEqual([]);
    expect(calls()).toBe(1);
  } finally {
    pause.mockRestore();
  }
});

const setupThenImplementNodes = [
  { id: 'setup', prompt: 'Set it up' },
  { id: 'implement', prompt: 'Implement it', depends_on: ['setup'] },
];
const setupThenImplement = makeTestResolvedWorkflow({
  name: 'rate-limit',
  nodes: setupThenImplementNodes,
});

/** Submit with the rate-limit retry delays shortened, so the retries run at once. */
async function submitThroughRetries(
  engine: InProcessWorkflowEngine,
  submitted: typeof workflow = setupThenImplement
): Promise<string> {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 1)) as typeof setTimeout;
  try {
    return await submit(engine, submitted);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}

/** `setup` succeeds, then `implement` is rate limited on its first attempt and every retry. */
function rateLimitedTurns(resetAt: string): ({ resetAt: string; rateLimited: true } | 'ok')[] {
  return ['ok', ...Array.from({ length: 6 }, () => ({ resetAt, rateLimited: true as const }))];
}

test('a rate limit that outlasts its retries pauses, then the continuation host continues from the limited node', async () => {
  const resetAt = new Date(Date.now() + 3_600_000).toISOString();
  const { engine, store, calls } = harness([...rateLimitedTurns(resetAt), 'ok']);

  const runId = await submitThroughRetries(engine);
  const waiting = await store.getWorkflowRun(runId);
  expect(waiting?.status).toBe('paused');
  expect(waiting?.metadata.wait).toMatchObject({
    kind: 'quota',
    nodeId: 'implement',
    resumeAt: resetAt,
  });
  expect(calls()).toBe(7);

  expect(
    await wake(engine, store, new Date(Date.parse(resetAt) - 1000), setupThenImplement)
  ).toEqual([]);
  expect(
    await wake(engine, store, new Date(Date.parse(resetAt) + 1000), setupThenImplement)
  ).toEqual([runId]);
  const finished = await store.getWorkflowRun(runId);
  expect(finished?.status).toBe('completed');
  expect(finished?.metadata.wait).toBeUndefined();
  // `setup` ran once: the continuation started at `implement`.
  expect(calls()).toBe(8);
});

test('a rate-limit pause resumed by hand continues before its deadline', async () => {
  const resetAt = new Date(Date.now() + 3_600_000).toISOString();
  const { engine, store, calls } = harness([...rateLimitedTurns(resetAt), 'ok']);

  const runId = await submitThroughRetries(engine);
  const run = await store.getWorkflowRun(runId);
  if (run === null) throw new Error('run missing');
  expect(run.status).toBe('paused');

  // No cursor: the path `archon workflow resume` and the resume API take.
  const admission = await engine.resume({
    run,
    platform,
    conversationId,
    cwd: root,
    userMessage: run.user_message,
    legacyWorkflow: setupThenImplement,
  });
  if (!admission.accepted) throw new Error('resume not accepted');
  await admission.settled;

  const finished = await store.getWorkflowRun(runId);
  expect(finished?.status).toBe('completed');
  expect(finished?.metadata.wait).toBeUndefined();
  expect(calls()).toBe(8);
});

test('a rate-limit pause keeps the run budget: the continuation is refused once the paid retries used it up', async () => {
  const budgeted = makeTestResolvedWorkflow({
    name: 'rate-limit-budgeted',
    nodes: setupThenImplementNodes,
    budget: { max_work_units: 7 },
  });
  const resetAt = new Date(Date.now() + 3_600_000).toISOString();
  const { engine, store, calls } = harness([...rateLimitedTurns(resetAt), 'ok']);

  // `setup` and the six rate-limited `implement` attempts spend all seven work units.
  const runId = await submitThroughRetries(engine, budgeted);
  expect(await store.getWorkflowRunStatus(runId)).toBe('paused');
  expect(calls()).toBe(7);

  expect(await wake(engine, store, new Date(Date.parse(resetAt) + 1000), budgeted)).toEqual([
    runId,
  ]);
  const refused = await store.getWorkflowRun(runId);
  expect(refused?.status).toBe('failed');
  expect(refused?.metadata[RUN_STOP_REASON_METADATA_KEY]).toMatchObject({
    reason: 'budget_refused',
  });
  expect(calls()).toBe(7);
});
