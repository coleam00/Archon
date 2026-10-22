import { resolveProjectPaths } from '@archon/workflows/run-paths';
import { listWorkflowEvents } from '@archon/core/db/workflow-events';
import { randomUUID } from 'node:crypto';
import { getOrCreateConversation } from '@archon/core/db/conversations';
import { listMessages } from '@archon/core/db/messages';
import { createSqlWorkflowHost } from '@archon/core/workflows/sql-host';
import { execFileSync } from 'node:child_process';
import { registerBuiltinProviders, registerCommunityProviders } from '@archon/providers/in-process';
import { saveUserProviderKey } from '@archon/core/db/user-provider-key-store';
import { getWorkflowRun, pauseWorkflowRun, resumeWorkflowRun } from '@archon/core/db/workflows';
import { execFileAsync } from '@archon/git';
/**
 * The server hosting resource starts against a real SQLite database, a real workflow
 * checkout and a real source-plugin module. Only the engine is recorded: it claims the
 * pending run exactly as the executor does, so the claim fence stays the real one.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OpenAPIHono } from '@hono/zod-openapi';
import { closeDatabase, getDatabase, resetDatabase } from '@archon/core/db/connection';
import { setPlatformPolicies } from '@archon/core/platforms/registry';
import { registerFolder, registerRepository } from '@archon/core';
import { updateCodebase, findCodebaseByDefaultCwd } from '@archon/core/db/codebases';
import { getStartReceipt, hasStartReceiptForDelivery } from '@archon/core/db/resource-starts';
import { claimPendingWorkflowRun } from '@archon/core/db/workflows';
import {
  drainResourceStartHost,
  startAdmittedResourceStart,
} from '@archon/core/workflows/resource-start-host';
import { captureLogLines, removeTempTree } from '@archon/paths/test-utils';
import type { IWorkflowEngine, WorkflowEngineSubmitInput } from '@archon/workflows/engine-port';
import { RESOURCE_START_METADATA_KEY } from '@archon/workflows/schemas/resource-start';
import { HeadlessPlatform } from '@archon/core/workflows/headless-platform';
import { registerWebhookSourceRoutes } from '../routes/webhooks';
import { createServerResourceStartHost } from './resource-start-hosting';
import { loadWebhookSourcePlugins } from './webhook-source-plugins';
import {
  startWorkflowContinuationScheduler,
  stopWorkflowContinuationScheduler,
} from './workflow-resume-service';

registerBuiltinProviders();
registerCommunityProviders();

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
    async subscribe() {
      throw new Error('not used');
    },
    async watchAttention() {
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
  isolation:
    | { kind: 'in-place' }
    | { kind: 'worktree'; fromBranch?: string; branch?: string }
    | { kind: 'default' } = {
    kind: 'in-place',
  },
  initGit = true,
  launchCwd?: string,
  mutatesCheckout?: boolean
): Promise<Fixture> {
  const project = join(root, 'project');
  await mkdir(join(project, '.archon', 'workflows'), { recursive: true });
  await writeFile(
    join(project, '.archon', 'workflows', 'hosted.yaml'),
    'name: hosted\ndescription: Server-hosted start.\n' +
      (mutatesCheckout === undefined ? '' : `mutates_checkout: ${String(mutatesCheckout)}\n`) +
      'nodes:\n  - id: one\n    bash: echo one\n'
  );
  if (initGit) expect(await Bun.spawn(['git', 'init', '-q'], { cwd: project }).exited).toBe(0);
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
                cwd: launchCwd ?? project,
                discoveryCwd: project,
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
  const workflowHost = { ...createSqlWorkflowHost(), engine };
  const host = createServerResourceStartHost(HOST_ID, workflowHost);
  const app = new OpenAPIHono();
  registerWebhookSourceRoutes(
    app,
    await loadWebhookSourcePlugins(configPath, {
      acceptReceipt: input => workflowHost.deps.store.acceptStartReceipt(input),
      isKnownUser: async id => (await workflowHost.records.users.getUserById(id)) !== null,
      hasDeliveryReceipt: hasStartReceiptForDelivery,
    }),
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
  // Conversations need a configured default provider.
  await mkdir(process.env.ARCHON_HOME);
  await writeFile(join(process.env.ARCHON_HOME, 'config.yaml'), 'defaultAssistant: claude\n');
  delete process.env.DATABASE_URL;
  setPlatformPolicies([]);
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
  test('a version-1 queued launch delivers output and metadata to its real conversation', async () => {
    const { deliver } = await fixture(false);
    expect((await deliver('blocker', 'queue')).status).toBe(200);
    const blockerId = await admitWithoutStarting();
    const sqlHost = createSqlWorkflowHost();
    const blocker = await sqlHost.deps.store.getResourceStartRequest(blockerId);
    if (!blocker) throw new Error('Missing blocker');
    const conversation = await getOrCreateConversation('cli', 'legacy-thread');
    const id = randomUUID();
    const launch = {
      ...blocker.launch,
      run: {
        ...blocker.launch.run,
        id,
        origin: { conversationId: conversation.id, userId: USER_ID },
      },
    };
    expect(
      (
        await sqlHost.deps.store.admitResourceStart({
          resource: blocker.resource,
          capacity: 1,
          hostId: HOST_ID,
          overlap: 'queue',
          launch,
        })
      ).status
    ).toBe('queued');
    const { origin: _origin, ...run } = launch.run;
    await getDatabase().query(
      'UPDATE remote_agent_resource_start_requests SET launch = $1 WHERE id = $2',
      [
        JSON.stringify({
          version: 1,
          run: { ...run, conversation_id: conversation.id, user_id: USER_ID },
          execution: launch.execution,
        }),
        id,
      ]
    );
    await sqlHost.deps.store.claimPendingWorkflowRun(blockerId);
    await sqlHost.deps.store.completeWorkflowRun(blockerId, { duration_ms: 1 });
    const engine = recordingEngine();
    let delivered = false;
    const host = createServerResourceStartHost(HOST_ID, {
      ...sqlHost,
      engine: {
        ...engine,
        async submit(input) {
          const result = await engine.submit(input);
          expect(input.origin).toEqual({ conversationId: conversation.id, userId: USER_ID });
          await input.platform.sendMessage(input.conversationId, 'Legacy output', {
            category: 'workflow_status',
            segment: 'new',
          });
          delivered = true;
          return result;
        },
      },
    });
    await host.requestDrain();
    await until(() => (delivered ? true : undefined));
    expect(engine.claimed).toEqual([id]);
    const messages = await listMessages(conversation.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      conversation_id: conversation.id,
      role: 'assistant',
      content: 'Legacy output',
    });
    expect(JSON.parse(messages[0].metadata)).toEqual({ category: 'workflow_status' });
  });

  test('a webhook receipt is prepared, admitted and started through the engine port', async () => {
    const { deliver, engine } = await fixture();
    await writeFile(join(root, 'home', 'config.yaml'), 'defaultAssistant: pi\n');
    await writeFile(join(root, 'project', '.archon', 'config.yaml'), 'assistant: codex\n');
    expect((await deliver('first', 'queue')).status).toBe(200);

    // Nothing but the route's post-commit hook drains this host.
    const submitted = await until(() => engine.submitted[0]);
    const binding = await bindingOf('first');
    expect(binding.disposition).toMatchObject({ status: 'admitted' });
    const runId = binding.disposition?.requestId;
    expect(submitted.options?.preCreatedRun?.id).toBe(runId);
    expect(submitted.options?.preCreatedRun?.status).toBe('pending');
    const run = submitted.options?.preCreatedRun;
    expect(run?.conversation_id).toBeNull();
    expect(run?.origin).toEqual({ userId: USER_ID });
    expect(submitted.workflow.name).toBe('hosted');
    // Provenance is data on the run, not prose in the user message.
    expect(submitted.userMessage).toBe('');
    expect(submitted.options?.preCreatedRun?.metadata[RESOURCE_START_METADATA_KEY]).toEqual({
      receiptId: await receiptIdOf('first'),
      bindingId: 'hosted',
    });
    await until(() => (engine.claimed.includes(runId ?? '') ? true : undefined));
  });

  test.each(['folder', 'repo'] as const)(
    'a nested repository belongs to itself under a registered parent %s',
    async parentKind => {
      if (parentKind === 'repo') {
        expect(await Bun.spawn(['git', 'init', '-q'], { cwd: root }).exited).toBe(0);
      }
      const parent = await (parentKind === 'repo'
        ? registerRepository(root)
        : registerFolder(root));
      const { deliver, engine, host } = await fixture(false);
      expect((await deliver('nested', 'queue')).status).toBe(200);
      await host.requestDrain();
      await until(() => engine.claimed[0]);
      const child = await findCodebaseByDefaultCwd(join(root, 'project'));
      expect(child).not.toBeNull();
      expect(child?.id).not.toBe(parent.codebaseId);
      expect(engine.submitted[0]?.options?.preCreatedRun?.codebase_id).toBe(child?.id);
    }
  );

  test('reuses an existing nested repository registration', async () => {
    const parent = await registerFolder(root);
    const { deliver, engine, host } = await fixture(false);
    const child = await registerRepository(join(root, 'project'));
    expect((await deliver('registered-child', 'queue')).status).toBe(200);
    await host.requestDrain();
    await until(() => engine.claimed[0]);
    expect(child.codebaseId).not.toBe(parent.codebaseId);
    expect(engine.submitted[0]?.options?.preCreatedRun?.codebase_id).toBe(child.codebaseId);
  });

  test('a folder descendant inside Git prepares and starts in place', async () => {
    expect(await Bun.spawn(['git', 'init', '-q', root]).exited).toBe(0);
    const project = join(root, 'project');
    const descendant = join(project, 'deep');
    await mkdir(descendant, { recursive: true });
    const folder = await registerFolder(project);
    const before = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: root,
      encoding: 'utf8',
    });
    const { deliver, engine, host } = await fixture(false, { kind: 'default' }, false, descendant);
    expect((await deliver('folder-in-git', 'queue')).status).toBe(200);
    await host.requestDrain();
    await until(() => engine.claimed[0]);
    const binding = await bindingOf('folder-in-git');
    const request = await createSqlWorkflowHost().deps.store.getResourceStartRequest(
      binding.disposition?.requestId ?? ''
    );
    expect(request?.launch).toMatchObject({
      run: { codebase_id: folder.codebaseId, working_path: await realpath(descendant) },
      execution: { cwd: await realpath(descendant), isolation: { kind: 'in-place' } },
    });
    expect(engine.submitted[0]?.cwd).toBe(await realpath(descendant));
    expect(engine.submitted[0]?.options?.codebaseId).toBe(folder.codebaseId);
    expect(engine.submitted[0]?.options?.ownedWorktree).toBeUndefined();
    expect(
      (await getDatabase().query('SELECT id FROM remote_agent_isolation_environments')).rows
    ).toEqual([]);
    expect(
      execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' })
    ).toBe(before);
  });

  test('retains parent folder resolution outside Git', async () => {
    const parent = await registerFolder(root);
    const { deliver, engine, host } = await fixture(false, { kind: 'in-place' }, false);
    expect((await deliver('folder-child', 'queue')).status).toBe(200);
    await host.requestDrain();
    await until(() => engine.claimed[0]);
    expect(engine.submitted[0]?.options?.preCreatedRun?.codebase_id).toBe(parent.codebaseId);
  });

  test.each([false, true])(
    'worktree provisioning is durable before engine submission (failure: %s)',
    async fails => {
      const { deliver, engine } = await fixture(false, { kind: 'worktree' });
      await writeFile(
        join(root, 'project', '.archon', 'config.yaml'),
        `worktree:\n  postCreate:\n    - echo setup-evidence; ${fails ? 'echo valuable > installer-output; exit 7' : 'true'}\n`
      );
      expect((await deliver('setup', 'queue')).status).toBe(200);
      const workflowHost = { ...createSqlWorkflowHost(), engine };
      const admitted: string[] = [];
      await drainResourceStartHost({
        ...workflowHost,
        hostId: HOST_ID,
        startAdmitted: async id => {
          admitted.push(id);
        },
      });
      const runId = admitted[0];
      if (!runId) throw new Error('Expected admitted run');
      const start = (): ReturnType<typeof startAdmittedResourceStart> =>
        startAdmittedResourceStart({
          host: workflowHost,
          hostId: HOST_ID,
          requestId: runId,
          createPlatform: () => new HeadlessPlatform(),
        });
      if (fails) {
        await expect(start()).rejects.toThrow('exit code 7');
        expect(engine.submitted).toHaveLength(0);
        expect((await getWorkflowRun(runId))?.status).toBe('pending');
      } else {
        await start();
        expect(engine.submitted[0]?.options?.preCreatedRun?.id).toBe(runId);
      }
      const events = await listWorkflowEvents(runId);
      const setup = events.filter(event => event.event_type.startsWith('worktree_setup_'));
      expect(setup.map(event => event.event_type)).toEqual([
        'worktree_setup_started',
        fails ? 'worktree_setup_failed' : 'worktree_setup_completed',
      ]);
      expect(setup[1]?.data?.stdoutTail).toContain('setup-evidence');
      const run = await getWorkflowRun(runId);
      if (!run) throw new Error('Expected setup audit owner');
      const { logDir } = await resolveProjectPaths(
        workflowHost.deps,
        join(root, 'project'),
        runId,
        run.codebase_id ?? undefined
      );
      const transcript: unknown[] = (await readFile(join(logDir, `${runId}.jsonl`), 'utf8'))
        .trim()
        .split('\n')
        .map((line: string) => JSON.parse(line));
      expect(transcript).toMatchObject([
        { type: setup[0]?.event_type, workflow_id: runId, setup: setup[0]?.data },
        { type: 'exec_output', stdout_tail: 'setup-evidence', exit_code: fails ? 7 : 0 },
        { type: setup[1]?.event_type, workflow_id: runId, setup: setup[1]?.data },
      ]);
      expect(setup[0]?.data?.message).toContain('started');
      expect(setup[1]?.data?.message).toContain(fails ? 'exit code 7' : 'completed');
      if (fails) {
        expect(setup[1]?.data?.exitCode).toBe(7);
        await expect(start()).rejects.toThrow('its setup did not finish');
        expect(engine.submitted).toHaveLength(0);
      }
    },
    30000
  );

  for (const base of [null, 'release']) {
    test(`resource start forwards ${String(base)} at worktree creation and engine submission`, async () => {
      const { deliver, engine, host } = await fixture(false, { kind: 'worktree' });
      const project = join(root, 'project');
      if (base) {
        execFileSync('git', ['-C', project, 'checkout', '-qb', base]);
        execFileSync('git', [
          '-C',
          project,
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@t',
          'commit',
          '--allow-empty',
          '-qm',
          'release',
        ]);
        execFileSync('git', ['-C', project, 'push', '-q', 'origin', base]);
        execFileSync('git', ['-C', project, 'checkout', '-q', 'main']);
      }
      const registered = await registerRepository(project);
      await updateCodebase(
        { id: registered.codebaseId, name: registered.name },
        { default_branch: base }
      );
      expect((await deliver('branch', 'queue')).status).toBe(200);
      await host.requestDrain();
      const submitted = await until(() => engine.submitted[0]);
      expect(submitted.options?.baseBranch).toBe(base ?? undefined);
      expect(submitted.cwd).not.toBe(join(root, 'project'));
      expect(submitted.options?.resolveChildIsolation).toBeDefined();
      const commit = (cwd: string, ref: string): string =>
        execFileSync('git', ['-C', cwd, 'rev-parse', ref], { encoding: 'utf8' }).trim();
      expect(commit(submitted.cwd, 'HEAD')).toBe(commit(project, `origin/${base ?? 'main'}`));
    }, 30000);
  }

  for (const mutatesCheckout of [undefined, true]) {
    test(`scheduler drains a guarded trigger after a manual holder ends (declaration ${String(mutatesCheckout)})`, async () => {
      const { deliver, engine, host } = await fixture(
        false,
        { kind: 'in-place' },
        false,
        undefined,
        mutatesCheckout
      );
      const workflowHost = createSqlWorkflowHost();
      const project = await realpath(join(root, 'project'));
      const codebase = await registerFolder(project);
      const manual = await workflowHost.deps.store.createWorkflowRun({
        workflow_name: 'manual',
        codebase_id: codebase.codebaseId,
        user_message: '',
      });
      await workflowHost.deps.store.claimPendingWorkflowRun(manual.id, project);
      expect((await deliver('foreign', 'queue')).status).toBe(200);
      await host.requestDrain();
      const queued = await bindingOf('foreign');
      expect(queued.disposition).toMatchObject({
        status: 'queued',
        blocker: { kind: 'run', id: manual.id },
      });
      const request = await workflowHost.deps.store.getResourceStartRequest(
        queued.disposition!.requestId
      );
      expect(request?.launch.run.metadata.admission_checkout_guard).toBe(true);
      expect(engine.submitted).toHaveLength(0);
      const nativeSetInterval = globalThis.setInterval;
      let tick = (): void => {
        throw new Error('scheduler did not register its tick');
      };
      const timer = spyOn(globalThis, 'setInterval').mockImplementation((callback: () => void) => {
        tick = callback;
        return nativeSetInterval(callback, 60_000);
      });
      try {
        startWorkflowContinuationScheduler(workflowHost, undefined, () => void host.requestDrain());
        await host.requestDrain();
        expect(engine.submitted).toHaveLength(0);
        expect(await workflowHost.deps.store.getResourceStartRequest(manual.id)).toBeNull();
        await workflowHost.deps.store.completeWorkflowRun(manual.id, { duration_ms: 1 });
        tick();
        await until(() => (engine.claimed.includes(request!.id) ? true : undefined));
        expect((await bindingOf('foreign')).disposition).toMatchObject({ status: 'admitted' });
      } finally {
        stopWorkflowContinuationScheduler();
        timer.mockRestore();
      }
    });
  }
  test('queued read-only declaration remains authoritative after workflow edits beside a foreign holder', async () => {
    const { deliver, engine, host } = await fixture(
      false,
      { kind: 'in-place' },
      false,
      undefined,
      false
    );
    const workflowHost = createSqlWorkflowHost();
    const project = await realpath(join(root, 'project'));
    const codebase = await registerFolder(project);
    const manual = await workflowHost.deps.store.createWorkflowRun({
      workflow_name: 'manual',
      codebase_id: codebase.codebaseId,
      user_message: '',
    });
    await workflowHost.deps.store.claimPendingWorkflowRun(manual.id, project);
    await deliver('first-readonly', 'queue');
    await host.requestDrain();
    await until(() => (engine.claimed.length === 1 ? true : undefined));
    await deliver('queued-readonly', 'queue');
    await host.requestDrain();
    const queued = await bindingOf('queued-readonly');
    expect(queued.disposition?.status).toBe('queued');
    const request = await workflowHost.deps.store.getResourceStartRequest(
      queued.disposition!.requestId
    );
    expect(request?.launch.run.metadata.admission_checkout_guard).toBe(false);
    await writeFile(
      join(project, '.archon/workflows/hosted.yaml'),
      'name: hosted\ndescription: Now mutates.\nmutates_checkout: true\nnodes:\n  - id: one\n    bash: echo changed\n'
    );
    await workflowHost.deps.store.completeWorkflowRun(engine.claimed[0]!, { duration_ms: 1 });
    await host.requestDrain();
    await until(() => (engine.claimed.length === 2 ? true : undefined));
    expect(engine.submitted[1]?.options?.preCreatedRun?.metadata.admission_checkout_guard).toBe(
      false
    );
    expect((await workflowHost.deps.store.getWorkflowRun(manual.id))?.status).toBe('running');
  });

  test('a queued receipt retains its prepared AI policy when config changes before admission', async () => {
    const { deliver, engine, host } = await fixture();
    const configPath = join(root, 'project', '.archon', 'config.yaml');
    await writeFile(
      configPath,
      'assistant: codex\nassistants:\n  codex:\n    model: launch-model\n'
    );
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
    await writeFile(
      configPath,
      'assistant: claude\nassistants:\n  codex:\n    model: changed-model\n'
    );

    await getDatabase().query(
      "UPDATE remote_agent_workflow_runs SET status = 'completed' WHERE id = $1",
      [firstRun]
    );
    // The scheduler's first tick runs immediately; no receipt or CLI drain happens here.
    startWorkflowContinuationScheduler(
      createSqlWorkflowHost(),
      undefined,
      () => void host.requestDrain()
    );
    const second = await until(() => engine.submitted[1]);
    expect(second.options?.preCreatedRun?.id).toBe(queued.disposition?.requestId);
    expect(second.options?.preparedAiConfiguration?.config.assistant).toBe('codex');
    expect(second.options?.preparedAiConfiguration?.config.assistants.codex.model).toBe(
      'launch-model'
    );
    expect(second.options?.preCreatedRun?.metadata.ai_configuration).toEqual(
      second.options?.preparedAiConfiguration?.aiConfigurationSnapshot
    );
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

  test('a dead connected credential fails before worktree creation and releases the resource slot on the next drain', async () => {
    const { deliver, engine } = await fixture(false, { kind: 'worktree' });
    const project = join(root, 'project');
    await writeFile(
      join(project, '.archon', 'workflows', 'hosted.yaml'),
      'name: hosted\ndescription: AI start\nnodes:\n  - id: one\n    provider: claude\n    prompt: do work\n'
    );
    await saveUserProviderKey({
      userId: USER_ID,
      provider: 'anthropic',
      kind: 'api_key',
      apiKey: 'planted-secret',
    });
    await getDatabase().query(
      "UPDATE remote_agent_user_provider_keys SET api_key_encrypted = 'unreadable' WHERE user_id = $1",
      [USER_ID]
    );
    const before = (
      await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: project })
    ).stdout;
    expect((await deliver('dead', 'queue')).status).toBe(200);
    const admitted: string[] = [];
    await drainResourceStartHost({
      ...createSqlWorkflowHost(),
      hostId: HOST_ID,
      startAdmitted: async id => {
        admitted.push(id);
      },
    });
    const result = await startAdmittedResourceStart({
      requestId: admitted[0],
      hostId: HOST_ID,
      host: { ...createSqlWorkflowHost(), engine },
      createPlatform: () => new HeadlessPlatform(),
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected credential refusal');
    expect(result.error).toBe(
      "Credential preflight failed for provider 'claude' (vendor 'anthropic'): credential cannot be used: The stored credential cannot be read."
    );
    expect(result.error).not.toContain('planted-secret');
    expect((await getWorkflowRun(admitted[0]))?.status).toBe('failed');
    expect(engine.submitted).toHaveLength(0);
    expect(
      (await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: project })).stdout
    ).toBe(before);
    expect((await deliver('next', 'queue')).status).toBe(200);
    await drainResourceStartHost({
      ...createSqlWorkflowHost(),
      hostId: HOST_ID,
      startAdmitted: async id => {
        admitted.push(id);
      },
    });
    expect(admitted).toHaveLength(2);
  });

  test('two starters of one admitted request execute it once', async () => {
    const { deliver, engine } = await fixture(false);
    expect((await deliver('first', 'queue')).status).toBe(200);
    // Admit without starting, so both starters race for the same pending run.
    const admitted: string[] = [];
    await drainResourceStartHost({
      ...createSqlWorkflowHost(),
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
        host: { ...createSqlWorkflowHost(), engine },
        createPlatform: () => new HeadlessPlatform(),
      });

    await Promise.allSettled([start(), start()]);
    expect(engine.claimed).toEqual([requestId]);
  });

  test('the resource-start signal guard keeps its admitted execution claim', async () => {
    const { deliver, engine } = await fixture(false);
    expect((await deliver('guard', 'queue')).status).toBe(200);
    const requestId = await admitWithoutStarting();
    let getExecutionClaim: () => string | null | undefined = () => {
      throw new Error('guard not installed');
    };
    let released = false;
    const submit = engine.submit.bind(engine);
    engine.submit = async input => {
      expect(getExecutionClaim()).toBeUndefined();
      input.options?.onExecutionClaimed?.('original-claim');
      expect(getExecutionClaim()).toBe('original-claim');
      const result = await submit(input);
      await pauseWorkflowRun(requestId, { nodeId: 'review', type: 'approval', message: '' });
      await resumeWorkflowRun(requestId);
      expect(getExecutionClaim()).toBe('original-claim');
      return result;
    };
    await startAdmittedResourceStart({
      requestId,
      hostId: HOST_ID,
      host: { ...createSqlWorkflowHost(), engine },
      createPlatform: () => new HeadlessPlatform(),
      guardOwnedRun: owned => {
        getExecutionClaim = owned.getExecutionClaim;
        return () => {
          released = true;
        };
      },
    });
    expect(released).toBe(true);
  });

  test('a worktree creation failure reports the classified isolation message, not raw git output', async () => {
    const { deliver, engine } = await fixture(false, {
      kind: 'worktree',
      fromBranch: 'no-such-branch',
    });
    expect((await deliver('first', 'queue')).status).toBe(200);
    const requestId = await admitWithoutStarting();

    await expect(
      startAdmittedResourceStart({
        requestId,
        hostId: HOST_ID,
        host: { ...createSqlWorkflowHost(), engine },
        createPlatform: () => new HeadlessPlatform(),
      })
    ).rejects.toThrow(/^\*\*Error:\*\* /);
    expect(engine.submitted).toHaveLength(0);
  });

  test.each([undefined, 'named-reuse'])(
    'a worktree start on branch %s records reuse on retry',
    async branch => {
      const { deliver, engine } = await fixture(false, {
        kind: 'worktree',
        ...(branch ? { branch } : {}),
      });
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
        async subscribe() {
          throw new Error('not used');
        },
        async watchAttention() {
          throw new Error('not used');
        },
      };
      const start = (target: IWorkflowEngine): ReturnType<typeof startAdmittedResourceStart> =>
        startAdmittedResourceStart({
          requestId,
          hostId: HOST_ID,
          host: { ...createSqlWorkflowHost(), engine: target },
          createPlatform: () => new HeadlessPlatform(),
        });

      await expect(start(failing)).rejects.toThrow('engine unavailable');
      // The operator's retry of the still-pending run reaches the engine in the same checkout.
      const logged = captureLogLines();
      try {
        expect((await start(engine)).success).toBe(true);
        expect(
          logged.lines.filter(line => line.msg === 'worktree_adopted' && line.level === 40)
        ).toHaveLength(1);
        const codebase = await findCodebaseByDefaultCwd(join(root, 'project'));
        if (!codebase) throw new Error('Expected registered project');
        const rows = await createSqlWorkflowHost().records.isolation.listByCodebase(codebase.id);
        expect(rows).toHaveLength(1);
        expect(rows[0].metadata.adopted).toBe(true);
      } finally {
        logged.restore();
      }
      expect(engine.claimed).toEqual([requestId]);
      expect(engine.submitted.map(input => input.cwd)).toEqual(failedCwds);
      expect(failedCwds).toHaveLength(1);
    }
  );

  test('a start that fails before submission logs its run and the recovery command', async () => {
    const { deliver } = await fixture(false);
    expect((await deliver('first', 'queue')).status).toBe(200);
    const host = createServerResourceStartHost(HOST_ID, {
      ...createSqlWorkflowHost(),
      engine: {
        async submit() {
          throw new Error('engine unavailable');
        },
        async resume() {
          throw new Error('not used');
        },
        async subscribe() {
          throw new Error('not used');
        },
        async watchAttention() {
          throw new Error('not used');
        },
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
    ...createSqlWorkflowHost(),
    hostId: HOST_ID,
    startAdmitted: async requestId => {
      admitted.push(requestId);
    },
  });
  const [requestId] = admitted;
  if (!requestId) throw new Error('nothing was admitted');
  return requestId;
}
