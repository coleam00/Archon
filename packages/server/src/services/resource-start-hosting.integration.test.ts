/**
 * The server hosting resource starts against a real SQLite database, a real workflow
 * checkout and a real source-plugin module. Only the engine is recorded: it claims the
 * pending run exactly as the executor does, so the claim fence stays the real one.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OpenAPIHono } from '@hono/zod-openapi';
import { closeDatabase, getDatabase, resetDatabase } from '@archon/core/db/connection';
import { getStartReceipt } from '@archon/core/db/resource-starts';
import { claimPendingWorkflowRun } from '@archon/core/db/workflows';
import {
  drainResourceStartHost,
  startAdmittedResourceStart,
} from '@archon/core/workflows/resource-start-host';
import { captureLogLines, removeTempTree } from '@archon/paths/test-utils';
import type { IWorkflowEngine, WorkflowEngineSubmitInput } from '@archon/workflows/engine-port';
import { RESOURCE_START_METADATA_KEY } from '@archon/workflows/schemas/resource-start';
import { HeadlessPlatform } from '../adapters/headless';
import { registerWebhookSourceRoutes } from '../routes/webhooks';
import { createServerResourceStartHost } from './resource-start-hosting';
import { loadWebhookSourcePlugins } from './webhook-source-plugins';
import {
  startWorkflowContinuationScheduler,
  stopWorkflowContinuationScheduler,
} from './workflow-resume-service';

const USER_ID = '22222222-2222-4222-8222-222222222222';
const HOST_ID = 'server-host';
let root = '';
const originalArchonHome = process.env.ARCHON_HOME;
const originalDatabaseUrl = process.env.DATABASE_URL;

/** Records every submission and takes the engine's real pending claim. */
function recordingEngine(): IWorkflowEngine & {
  submitted: WorkflowEngineSubmitInput[];
  claimed: string[];
} {
  const submitted: WorkflowEngineSubmitInput[] = [];
  const claimed: string[] = [];
  return {
    submitted,
    claimed,
    async submit(input) {
      submitted.push(input);
      const run = input.options?.preCreatedRun;
      if (!run) throw new Error('resource starts always submit a pre-created run');
      const claim = await claimPendingWorkflowRun(run.id);
      if (!claim) return { success: false, workflowRunId: run.id, error: 'claim lost' };
      claimed.push(run.id);
      return { success: true, workflowRunId: run.id };
    },
    async resume() {
      throw new Error('not used');
    },
  };
}

// A deadline, not an attempt count: on a Windows runner one drain (source capture, git,
// SQLite) can take longer than the ~2 s that 200 short polls used to allow.
const UNTIL_DEADLINE_MS = 15_000;

async function until<T>(read: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + UNTIL_DEADLINE_MS;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(10);
  }
  throw new Error(`condition not reached within ${String(UNTIL_DEADLINE_MS)} ms`);
}

interface Fixture {
  app: OpenAPIHono;
  engine: ReturnType<typeof recordingEngine>;
  host: ReturnType<typeof createServerResourceStartHost>;
  deliver: (delivery: string, overlap: 'skip' | 'queue') => Promise<Response>;
}

async function fixture(
  autoDrain = true,
  isolation: { kind: 'in-place' } | { kind: 'worktree' } = { kind: 'in-place' }
): Promise<Fixture> {
  const project = join(root, 'project');
  await mkdir(join(project, '.archon', 'workflows'), { recursive: true });
  await writeFile(
    join(project, '.archon', 'workflows', 'hosted.yaml'),
    'name: hosted\ndescription: Server-hosted start.\nnodes:\n  - id: one\n    bash: echo one\n'
  );
  expect(await Bun.spawn(['git', 'init', '-q'], { cwd: project }).exited).toBe(0);
  if (isolation.kind === 'worktree') {
    // A worktree syncs from the remote's base branch, so give the project a local one.
    const origin = join(root, 'origin.git');
    for (const [cwd, argv] of [
      [root, ['git', 'init', '-q', '--bare', '-b', 'main', origin]],
      [project, ['git', 'checkout', '-q', '-b', 'main']],
      [
        project,
        [
          'git',
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@t',
          'commit',
          '-q',
          '--allow-empty',
          '-m',
          'base',
        ],
      ],
      [project, ['git', 'remote', 'add', 'origin', origin]],
      [project, ['git', 'push', '-q', 'origin', 'main']],
      [project, ['git', 'remote', 'set-head', 'origin', 'main']],
    ] as const) {
      expect(await Bun.spawn([...argv], { cwd }).exited).toBe(0);
    }
  }

  // The module is an installed plugin: it trusts nothing but its own config.
  const modulePath = join(root, 'plugin.mjs');
  await writeFile(
    modulePath,
    `export default ({ sourceInstanceId, config }) => ({
      async receive(request) {
        const body = JSON.parse(request.body);
        return {
          status: 'received',
          acceptance: {
            receipt: {
              id: crypto.randomUUID(),
              sourceInstanceId,
              deliveryId: body.delivery,
              contentDigest: 'sha256:' + body.delivery,
              receivedAt: request.receivedAt,
              occurredAt: null,
              sourceActor: null,
            },
            outcome: 'matched',
            bindings: [{ ...config.binding, overlap: body.overlap }],
          },
        };
      },
    });\n`
  );
  const configPath = join(root, 'sources.json');
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      sources: [
        {
          sourceInstanceId: 'events',
          module: modulePath,
          config: {
            binding: {
              bindingId: 'hosted',
              bindingRevision: null,
              hostId: HOST_ID,
              runAsUserId: USER_ID,
              resource: 'repo:hosted',
              capacity: 1,
              launch: {
                cwd: project,
                workflowName: 'hosted',
                inputs: {},
                isolation,
              },
            },
          },
        },
      ],
    })
  );

  const engine = recordingEngine();
  const host = createServerResourceStartHost(HOST_ID, engine);
  const app = new OpenAPIHono();
  registerWebhookSourceRoutes(
    app,
    await loadWebhookSourcePlugins(configPath),
    autoDrain ? (): void => void host.requestDrain() : undefined
  );
  return {
    app,
    engine,
    host,
    deliver: async (delivery, overlap) =>
      await app.request('/webhooks/sources/events', {
        method: 'POST',
        body: JSON.stringify({ delivery, overlap }),
      }),
  };
}

async function receiptIdOf(delivery: string): Promise<string> {
  const row = await getDatabase().query<{ id: string }>(
    'SELECT id FROM remote_agent_start_receipts WHERE delivery_id = $1',
    [delivery]
  );
  return row.rows[0]?.id ?? '';
}

async function bindingOf(delivery: string): Promise<{
  status: string;
  disposition: { status: string; requestId: string } | null;
}> {
  const receipt = await getStartReceipt(await receiptIdOf(delivery));
  const binding = receipt?.bindings[0];
  if (!binding) throw new Error(`no binding recorded for ${delivery}`);
  return binding;
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'archon-server-resource-host-')));
  process.env.ARCHON_HOME = join(root, 'home');
  delete process.env.DATABASE_URL;
  resetDatabase();
  await getDatabase().query(
    `INSERT INTO remote_agent_users (id, display_name) VALUES ($1, 'Trigger actor')`,
    [USER_ID]
  );
});

afterEach(async () => {
  stopWorkflowContinuationScheduler();
  await closeDatabase();
  if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalArchonHome;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  await removeTempTree(root);
});

describe('server resource-start host', () => {
  test('a webhook receipt is prepared, admitted and started through the engine port', async () => {
    const { deliver, engine } = await fixture();
    expect((await deliver('first', 'queue')).status).toBe(200);

    // Nothing but the route's post-commit hook drains this host.
    const submitted = await until(() => engine.submitted[0]);
    const binding = await bindingOf('first');
    expect(binding.disposition).toMatchObject({ status: 'admitted' });
    const runId = binding.disposition?.requestId;
    expect(submitted.options?.preCreatedRun?.id).toBe(runId);
    expect(submitted.options?.preCreatedRun?.status).toBe('pending');
    expect(submitted.workflow.name).toBe('hosted');
    // Provenance is data on the run, not prose in the user message.
    expect(submitted.userMessage).toBe('');
    expect(submitted.options?.preCreatedRun?.metadata[RESOURCE_START_METADATA_KEY]).toEqual({
      receiptId: await receiptIdOf('first'),
      bindingId: 'hosted',
    });
    await until(() => (engine.claimed.includes(runId ?? '') ? true : undefined));
  });

  test('a queued receipt starts when its blocker ends and the scheduler tick drains', async () => {
    const { deliver, engine, host } = await fixture();
    expect((await deliver('first', 'queue')).status).toBe(200);
    const firstRun = (await until(() => engine.submitted[0])).options?.preCreatedRun?.id;
    await until(() => (engine.claimed.length === 1 ? true : undefined));

    expect((await deliver('second', 'queue')).status).toBe(200);
    const queued = await until(async () => {
      const binding = await bindingOf('second');
      return binding.status === 'complete' ? binding : undefined;
    });
    expect(queued.disposition).toMatchObject({
      status: 'queued',
      blocker: { kind: 'run', id: firstRun },
    });
    await host.requestDrain();
    expect(engine.submitted).toHaveLength(1);

    await getDatabase().query(
      "UPDATE remote_agent_workflow_runs SET status = 'completed' WHERE id = $1",
      [firstRun]
    );
    // The scheduler's first tick runs immediately; no receipt or CLI drain happens here.
    startWorkflowContinuationScheduler(undefined, () => void host.requestDrain());
    const second = await until(() => engine.submitted[1]);
    expect(second.options?.preCreatedRun?.id).toBe(queued.disposition?.requestId);
    expect((await bindingOf('second')).disposition).toMatchObject({ status: 'admitted' });
  });

  test('skip records its disposition and starts nothing', async () => {
    const { deliver, engine, host } = await fixture();
    expect((await deliver('first', 'queue')).status).toBe(200);
    const firstRun = (await until(() => engine.submitted[0])).options?.preCreatedRun?.id;

    expect((await deliver('skipped', 'skip')).status).toBe(200);
    const skipped = await until(async () => {
      const binding = await bindingOf('skipped');
      return binding.status === 'complete' ? binding : undefined;
    });
    expect(skipped.disposition).toMatchObject({
      status: 'skipped',
      blocker: { kind: 'run', id: firstRun },
    });
    await host.requestDrain();
    expect(engine.submitted).toHaveLength(1);
  });

  test('two starters of one admitted request execute it once', async () => {
    const { deliver, engine } = await fixture(false);
    expect((await deliver('first', 'queue')).status).toBe(200);
    // Admit without starting, so both starters race for the same pending run.
    const admitted: string[] = [];
    await drainResourceStartHost({
      hostId: HOST_ID,
      startAdmitted: async requestId => {
        admitted.push(requestId);
      },
    });
    const [requestId] = admitted;
    if (!requestId) throw new Error('nothing was admitted');
    const start = (): ReturnType<typeof startAdmittedResourceStart> =>
      startAdmittedResourceStart({
        requestId,
        hostId: HOST_ID,
        engine,
        createPlatform: ({ conversationDbId }) => new HeadlessPlatform(conversationDbId),
      });

    await Promise.allSettled([start(), start()]);
    expect(engine.claimed).toEqual([requestId]);
  });

  test('an unbranched worktree start that failed before submission reuses its checkout on retry', async () => {
    const { deliver, engine } = await fixture(false, { kind: 'worktree' });
    expect((await deliver('first', 'queue')).status).toBe(200);
    const requestId = await admitWithoutStarting();
    const failedCwds: string[] = [];
    const failing: IWorkflowEngine = {
      async submit(input) {
        failedCwds.push(input.cwd);
        throw new Error('engine unavailable');
      },
      async resume() {
        throw new Error('not used');
      },
    };
    const start = (target: IWorkflowEngine): ReturnType<typeof startAdmittedResourceStart> =>
      startAdmittedResourceStart({
        requestId,
        hostId: HOST_ID,
        engine: target,
        createPlatform: ({ conversationDbId }) => new HeadlessPlatform(conversationDbId),
      });

    await expect(start(failing)).rejects.toThrow('engine unavailable');
    // The operator's retry of the still-pending run reaches the engine in the same checkout.
    expect((await start(engine)).success).toBe(true);
    expect(engine.claimed).toEqual([requestId]);
    expect(engine.submitted.map(input => input.cwd)).toEqual(failedCwds);
    expect(failedCwds).toHaveLength(1);
  });

  test('a start that fails before submission logs its run and the recovery command', async () => {
    const { deliver } = await fixture(false);
    expect((await deliver('first', 'queue')).status).toBe(200);
    const host = createServerResourceStartHost(HOST_ID, {
      async submit() {
        throw new Error('engine unavailable');
      },
      async resume() {
        throw new Error('not used');
      },
    });

    const logged = captureLogLines();
    try {
      await host.requestDrain();
      const line = await until(() =>
        logged.lines.find(entry => entry.msg === 'resource_start.start_failed')
      );
      const runId = (await bindingOf('first')).disposition?.requestId;
      expect(line).toMatchObject({
        runId,
        recoveryCommand: `archon trigger inspect ${runId ?? ''}`,
      });
    } finally {
      logged.restore();
    }
  });
});

/** Admit the host's pending work without starting it; returns the one admitted request. */
async function admitWithoutStarting(): Promise<string> {
  const admitted: string[] = [];
  await drainResourceStartHost({
    hostId: HOST_ID,
    startAdmitted: async requestId => {
      admitted.push(requestId);
    },
  });
  const [requestId] = admitted;
  if (!requestId) throw new Error('nothing was admitted');
  return requestId;
}
