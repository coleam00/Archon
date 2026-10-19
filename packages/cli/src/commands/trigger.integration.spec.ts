import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { JsonValue } from '@archon/workflows/output-ref';
import { getRunArtifactsDirForRoot } from '@archon/paths';
import { removeTempTree } from '@archon/paths/test-utils';
import { timerTriggerConfigSchema } from './trigger';
import { standardWebhooksSourceConfigSchema } from '@archon/adapters/sources/standard-webhooks/source-plugin';
import {
  isTerminalRunStatus,
  type WorkflowRunStatus,
} from '@archon/workflows/schemas/workflow-run';
import { requestDetachedRunStop } from '@archon/core/services/run-owner-stop';

const tempRoots: string[] = [];
const activeRuns = new Set<string>();
const DEADLINE_MS = 15_000;

afterEach(async () => {
  for (const runId of activeRuns) {
    try {
      const target = await requestDetachedRunStop(runId);
      await target.stop();
    } catch {
      // A completed execution owner has already removed its endpoint.
    }
  }
  activeRuns.clear();
  for (const root of tempRoots.splice(0)) await removeTempTree(root);
});

async function waitFor<T>(read: () => T | undefined, label: string): Promise<T> {
  const deadline = Date.now() + DEADLINE_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = read();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(25);
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for ${label}${detail}`);
}

async function runCli(
  cliPath: string,
  cwd: string,
  archonHome: string,
  args: string[],
  expectSuccess = true
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, cliPath, ...args], {
    cwd,
    env: {
      ...process.env,
      DATABASE_URL: '',
      ARCHON_HOME: archonHome,
      TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32),
      ARCHON_SOURCE_PLUGIN_TEST_SECRET: 'test-secret',
      GITHUB_TOKEN: '',
      GH_TOKEN: '',
      GITHUB_APP_ID: '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (expectSuccess && exitCode !== 0) {
    throw new Error(`CLI failed (${String(exitCode)}): ${stderr || stdout}`);
  }
  return { exitCode, stdout, stderr };
}

interface RequestRow {
  id: string;
  status: 'queued' | 'admitted' | 'skipped' | 'withdrawn';
  launch: string;
}

interface RunRow {
  id: string;
  status: WorkflowRunStatus;
  metadata: string;
  output_root: string | null;
}

function readRows<T>(databasePath: string, sql: string): T[] {
  if (!existsSync(databasePath)) return [];
  const database = new Database(databasePath, { readonly: true });
  try {
    database.run('PRAGMA busy_timeout = 5000');
    return database.query<T, []>(sql).all();
  } finally {
    database.close();
  }
}

/**
 * The node holds until the test creates `release`, so the first run keeps the
 * capacity-1 slot for exactly as long as the test needs a second start to queue
 * behind it. Runs that start after the release pass straight through. The loop is
 * bounded so a run the teardown fails to stop cannot outlive the job.
 */
function workflow(marker: string, release: string): string {
  return `name: queued-trigger-proof
description: Durable trigger source proof.
mutates_checkout: false
inputs:
  count:
    required: true
nodes:
  - id: hold
    bash: |
      for _ in $(seq 240); do [ -f '${release}' ] && break; sleep 0.25; done
      [ -f '${release}' ] || { echo "hold: no release file at ${release} after 60 s" >&2; exit 1; }
      echo "${marker}-$INPUTS_COUNT-$TRIGGER_CONFIG_PROOF" > "$ARTIFACTS_DIR/result.txt"
`;
}

describe('trigger CLI durable execution', () => {
  test.skipIf(process.platform === 'win32')(
    'published polling recipes distinguish delimiter collisions and replay on both hosts',
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'archon-poll-recipes-')));
      tempRoots.push(root);
      const archonHome = join(root, 'home');
      const projectRoot = join(root, 'project');
      const workflowsDir = join(projectRoot, '.archon', 'workflows');
      mkdirSync(workflowsDir, { recursive: true });
      expect(await Bun.spawn(['git', 'init', '-q'], { cwd: projectRoot }).exited).toBe(0);
      const packagesRoot = resolve(import.meta.dir, '../../..');
      const guide = readFileSync(
        join(packagesRoot, 'docs-web/src/content/docs/guides/workflow-triggers.md'),
        'utf8'
      );
      const section = guide
        .split('## Poll a system that cannot send webhooks')[1]
        ?.split('## Preparation')[0];
      if (!section) throw new Error('Polling guide section missing');
      const yaml = section.match(/```yaml\n([\s\S]*?)```/)?.[1];
      const configJson = section.match(/```json\n([\s\S]*?)```/)?.[1];
      const scripts = [...section.matchAll(/```bash\n(#!\/bin\/sh[\s\S]*?)```/g)].map(
        match => match[1]
      );
      expect(scripts).toHaveLength(2);
      if (!yaml || !configJson) throw new Error('Polling workflow or config missing');
      writeFileSync(join(workflowsDir, 'process-order.yaml'), yaml);
      const cliPath = resolve(import.meta.dir, '..', 'cli.ts');
      await runCli(cliPath, projectRoot, archonHome, [
        'validate',
        'workflows',
        'process-order',
        '--cwd',
        projectRoot,
      ]);
      const identity = JSON.parse(
        (await runCli(cliPath, projectRoot, archonHome, ['trigger', 'whoami'])).stdout
      ) as { runAsUserId: string };
      const config = timerTriggerConfigSchema.parse(JSON.parse(configJson));
      config.binding.runAsUserId = identity.runAsUserId;
      config.binding.launch.cwd = projectRoot;
      // The server recipe defers to the guide's Standard Webhooks source; only
      // installation-local values are replaced.
      const webhookJson = guide
        .split('## Start workflows from any signed webhook')[1]
        ?.split('### Sign a delivery')[0]
        ?.match(/```json\n([\s\S]*?)```/)?.[1];
      if (!webhookJson) throw new Error('Webhook source config missing');
      const webhookSource = (
        JSON.parse(webhookJson) as {
          sources: [{ sourceInstanceId: string; config: unknown }];
        }
      ).sources[0];
      const webhookConfig = standardWebhooksSourceConfigSchema.parse(webhookSource.config);
      for (const binding of webhookConfig.bindings) {
        binding.runAsUserId = identity.runAsUserId;
        binding.launch.cwd = projectRoot;
      }
      const configPath = join(root, 'trigger.json');
      writeFileSync(configPath, JSON.stringify(config));
      const shellQuote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
      const wrapper = join(root, 'archon');
      writeFileSync(
        wrapper,
        `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cliPath)} "$@"\n`,
        { mode: 0o700 }
      );
      const cliScript = join(root, 'cli-poll.sh');
      const serverScript = join(root, 'server-poll.sh');
      writeFileSync(
        cliScript,
        scripts[0]
          .replaceAll('/opt/archon/bin/archon', shellQuote(wrapper))
          .replaceAll('/srv/archon/polled-orders.json', shellQuote(configPath))
      );
      writeFileSync(serverScript, scripts[1]);
      const items = [
        { id: 'order-123', version: '1' },
        { id: 'a@b', version: 'c' },
        { id: 'a', version: 'b@c' },
      ];
      const portPath = join(root, 'port');
      const fixturePath = join(root, 'server.ts');
      writeFileSync(
        fixturePath,
        `
        import { renameSync } from 'node:fs';
        import { createSqlWorkflowHost } from ${JSON.stringify(join(packagesRoot, 'core/src/workflows/sql-host.ts'))};
        import createSource from ${JSON.stringify(join(packagesRoot, 'adapters/src/sources/standard-webhooks/source-plugin.ts'))};
        import { SourceReceiptDigestConflictError } from ${JSON.stringify(join(packagesRoot, 'workflows/src/resource-start-store.ts'))};
        const host = createSqlWorkflowHost();
        const source = await createSource({ sourceInstanceId: ${JSON.stringify(webhookSource.sourceInstanceId)}, config: ${JSON.stringify(webhookConfig)} });
        const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
          if (new URL(request.url).pathname === '/items') return Response.json(${JSON.stringify(items)});
          const result = await source.receive({ body: await request.text(), headers: Object.fromEntries(request.headers), receivedAt: new Date().toISOString() });
          if (result.status === 'rejected') return new Response('Invalid signature', { status: 401 });
          try {
            return new Response(JSON.stringify(await host.deps.store.acceptStartReceipt(result.acceptance)) + '\\n');
          } catch (error) {
            if (error instanceof SourceReceiptDigestConflictError) return new Response('Delivery conflict', { status: 409 });
            throw error;
          }
        }});
        await Bun.write(${JSON.stringify(`${portPath}.tmp`)}, String(server.port));
        renameSync(${JSON.stringify(`${portPath}.tmp`)}, ${JSON.stringify(portPath)});
      `
      );
      const env = {
        ...process.env,
        ARCHON_HOME: archonHome,
        DATABASE_URL: '',
        TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32),
        GITHUB_TOKEN: '',
        GH_TOKEN: '',
        GITHUB_APP_ID: '',
        [webhookConfig.signingSecretEnv]:
          'whsec_' + Buffer.from('recipe-test-key').toString('base64'),
      };
      const server = Bun.spawn([process.execPath, fixturePath], {
        cwd: projectRoot,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const serverOutput = new Response(server.stderr).text();
      try {
        const port = await waitFor(
          () => (existsSync(portPath) ? readFileSync(portPath, 'utf8') || undefined : undefined),
          'recipe fixture port'
        );
        const runScript = async (path: string, syntaxOnly = false): Promise<string> => {
          const child = Bun.spawn(['sh', ...(syntaxOnly ? ['-n'] : []), path], {
            cwd: projectRoot,
            env: {
              ...env,
              ORDERS_URL: `http://127.0.0.1:${port}/items`,
              ARCHON_WEBHOOK_URL: `http://127.0.0.1:${port}/webhook`,
            },
            stdout: 'pipe',
            stderr: 'pipe',
          });
          const [code, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          expect(code, stderr || stdout).toBe(0);
          return stdout;
        };
        await runScript(cliScript, true);
        await runScript(serverScript, true);
        await runScript(cliScript);
        await runScript(cliScript);
        const databasePath = join(archonHome, 'archon.db');
        const runs = await waitFor(() => {
          const rows = readRows<RunRow>(
            databasePath,
            'SELECT id,status,metadata,output_root FROM remote_agent_workflow_runs'
          );
          for (const row of rows) if (row.status !== 'completed') activeRuns.add(row.id);
          return rows.length === items.length && rows.every(row => row.status === 'completed')
            ? rows
            : undefined;
        }, 'polled runs to complete');
        expect(
          runs
            .map(row => {
              if (!row.output_root) throw new Error('Polled run has no output root');
              return readFileSync(
                join(getRunArtifactsDirForRoot(row.output_root, row.id), 'order.txt'),
                'utf8'
              ).trim();
            })
            .sort()
        ).toEqual(items.map(item => item.id).sort());
        for (const run of runs) activeRuns.delete(run.id);
        const first = (await runScript(serverScript))
          .trim()
          .split('\n')
          .map(line => JSON.parse(line) as { receiptId: string; replay: boolean });
        const replay = (await runScript(serverScript))
          .trim()
          .split('\n')
          .map(line => JSON.parse(line) as { receiptId: string; replay: boolean });
        expect(first).toHaveLength(items.length);
        expect(replay).toEqual(first.map(result => ({ ...result, replay: true })));
        expect(first.every(result => result.replay === false)).toBe(true);
        for (const source of [config.sourceInstanceId, webhookSource.sourceInstanceId]) {
          const receipts = readRows<{ delivery_id: string; outcome: string }>(
            databasePath,
            `SELECT delivery_id,outcome FROM remote_agent_start_receipts WHERE source_instance_id='${source}'`
          );
          // A guide mapping that no longer resolves against the recipe body records unmatched receipts.
          expect(receipts.map(row => row.outcome)).toEqual(items.map(() => 'matched'));
          const keys = receipts.map(row => row.delivery_id);
          expect(new Set(keys).size).toBe(items.length);
        }
      } finally {
        for (const run of readRows<RunRow>(
          join(archonHome, 'archon.db'),
          'SELECT id,status FROM remote_agent_workflow_runs'
        ))
          if (!isTerminalRunStatus(run.status)) activeRuns.add(run.id);
        server.kill();
        await server.exited;
        const stderr = await serverOutput;
        if (stderr) console.error(stderr);
      }
    },
    30_000
  );

  test('keyed replay without inputs drains the frozen host and queued source after binding edits', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'archon-trigger-integration-')));
    tempRoots.push(root);
    const archonHome = join(root, 'home');
    const projectRoot = join(root, 'project');
    const workflowsDir = join(projectRoot, '.archon', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    const release = join(root, 'release');
    writeFileSync(join(workflowsDir, 'queued-trigger-proof.yaml'), workflow('ORIGINAL', release));
    const gitInit = Bun.spawn(['git', 'init', '-q'], { cwd: projectRoot });
    expect(await gitInit.exited).toBe(0);

    const cliPath = resolve(import.meta.dir, '..', 'cli.ts');
    const databasePath = join(archonHome, 'archon.db');
    const userId = crypto.randomUUID();
    const configPath = join(root, 'trigger.json');
    const runConfigPath = join(root, 'run-config.json');
    writeFileSync(
      runConfigPath,
      JSON.stringify({ env: { TRIGGER_CONFIG_PROOF: 'original-config' } })
    );
    const config = {
      version: 1,
      sourceInstanceId: 'integration-timer',
      binding: {
        bindingId: 'queued-trigger-proof',
        bindingRevision: null,
        hostId: 'integration-host',
        runAsUserId: userId,
        resource: 'integration:shared-resource',
        overlap: 'queue',
        launch: {
          cwd: projectRoot,
          workflowName: 'queued-trigger-proof',
          configSource: runConfigPath,
          inputs: { count: 7 },
          isolation: { kind: 'in-place' },
        },
      },
      schedule: { intervalSeconds: 60, runAtLoad: false },
    };
    writeFileSync(configPath, JSON.stringify(config));

    // The first DB-backed command creates the scratch schema, then fails closed because
    // the configured actor does not exist yet. Seed only that actor into the scratch DB.
    const initialize = await runCli(
      cliPath,
      projectRoot,
      archonHome,
      ['trigger', 'fire', '--config', configPath],
      false
    );
    expect(initialize.exitCode).not.toBe(0);
    const database = new Database(databasePath);
    try {
      database
        .query('INSERT INTO remote_agent_users (id, display_name) VALUES (?, ?)')
        .run(userId, 'Trigger integration actor');
    } finally {
      database.close();
    }

    await runCli(cliPath, projectRoot, archonHome, ['trigger', 'fire', '--config', configPath]);
    const firstRun = await waitFor(() => {
      const rows = readRows<RunRow>(
        databasePath,
        'SELECT id,status,metadata,output_root FROM remote_agent_workflow_runs ORDER BY started_at'
      );
      return rows[0]?.status === 'running' ? rows[0] : undefined;
    }, 'first trigger run to claim execution');
    activeRuns.add(firstRun.id);

    const keyedFire = ['trigger', 'fire', '--config', configPath, '--delivery-id', 'queued-item'];
    const accepted = await runCli(cliPath, projectRoot, archonHome, keyedFire);
    const originalReceipt = JSON.parse(accepted.stdout) as { id: string };
    const queued = await waitFor(() => {
      const rows = readRows<RequestRow>(
        databasePath,
        'SELECT id,status,launch FROM remote_agent_resource_start_requests ORDER BY queue_position'
      );
      return rows.length === 2 && rows[1]?.status === 'queued' ? rows : undefined;
    }, 'second start to enter the durable queue');
    const queuedLaunch = JSON.parse(queued[1].launch) as {
      run: { metadata: { inputs?: { count?: unknown }; inputs_values?: { count?: unknown } } };
    };
    expect(queued[1].launch).not.toContain('original-config');
    expect(queuedLaunch.run.metadata.inputs?.count).toBe('7');
    expect(queuedLaunch.run.metadata.inputs_values?.count).toBe(7);

    // Change the live authoring checkout after intake. Cold drain must execute the
    // finalized capture owned by the queued request, not discover these new bytes.
    writeFileSync(join(workflowsDir, 'queued-trigger-proof.yaml'), workflow('EDITED', release));
    writeFileSync(
      runConfigPath,
      JSON.stringify({ env: { TRIGGER_CONFIG_PROOF: 'edited-config' } })
    );
    config.binding.hostId = 'edited-host';
    config.binding.launch.inputs.count = 999;
    writeFileSync(configPath, JSON.stringify(config));
    writeFileSync(release, '');
    await waitFor(() => {
      const row = readRows<RunRow>(
        databasePath,
        `SELECT id,status,metadata,output_root FROM remote_agent_workflow_runs WHERE id='${firstRun.id}'`
      )[0];
      return row?.status === 'completed' ? row : undefined;
    }, 'first trigger run to complete');
    activeRuns.delete(firstRun.id);

    const replay = await runCli(cliPath, projectRoot, archonHome, keyedFire);
    expect(JSON.parse(replay.stdout)).toMatchObject({
      id: originalReceipt.id,
      deliveryId: 'queued-item',
      bindings: [
        expect.objectContaining({
          hostId: 'integration-host',
          requestStatus: 'admitted',
          intent: expect.objectContaining({
            launch: expect.objectContaining({ inputs: { count: 7 } }),
          }),
        }),
      ],
    });
    expect(readRows(databasePath, 'SELECT id FROM remote_agent_start_receipts')).toHaveLength(2);
    expect(
      readRows(databasePath, 'SELECT id FROM remote_agent_resource_start_requests')
    ).toHaveLength(2);
    const runs = await waitFor(() => {
      const rows = readRows<RunRow>(
        databasePath,
        'SELECT id,status,metadata,output_root FROM remote_agent_workflow_runs ORDER BY started_at'
      );
      if (rows[1] && rows[1].status !== 'completed' && rows[1].status !== 'failed') {
        activeRuns.add(rows[1].id);
      }
      if (rows.length !== 2 || rows[1]?.status !== 'completed') return undefined;
      return rows;
    }, 'cold-drained queued run to complete');
    activeRuns.delete(runs[1].id);

    for (const run of runs) {
      expect((JSON.parse(run.metadata) as { inputs?: { count?: unknown } }).inputs?.count).toBe(
        '7'
      );
      expect(
        (JSON.parse(run.metadata) as { inputs_values?: { count?: unknown } }).inputs_values?.count
      ).toBe(7);
      if (!run.output_root) throw new Error(`Run ${run.id} recorded no output root`);
      const artifacts = getRunArtifactsDirForRoot(run.output_root, run.id);
      expect(readFileSync(join(artifacts, 'result.txt'), 'utf8').trim()).toBe(
        'ORIGINAL-7-original-config'
      );
    }
    expect(
      readRows<RequestRow>(
        databasePath,
        'SELECT id,status,launch FROM remote_agent_resource_start_requests ORDER BY queue_position'
      ).map(row => row.status)
    ).toEqual(['admitted', 'admitted']);

    config.binding.hostId = 'integration-host';
    const forgeConfigPath = join(root, 'forge.json');
    const { bindingRevision, ...bindingWithoutRevision } = config.binding;
    void bindingRevision;
    const forgeBinding = { ...bindingWithoutRevision, bindingId: 'pr-opened' };
    const forgeConfig = {
      version: 1,
      webhookSecretEnv: 'ARCHON_SOURCE_PLUGIN_TEST_SECRET',
      host: 'github.com',
      bindings: [
        {
          ...forgeBinding,
          selector: { kind: 'pr.lifecycle', actions: ['opened'] },
          inputMapping: { count: { source: 'field', field: 'subject.number' } },
        },
      ],
    };
    const packagesRoot = resolve(import.meta.dir, '../../..');
    const pluginInstall = join(root, 'installed-github-plugin');
    const built = await Bun.build({
      entrypoints: [join(packagesRoot, 'adapters/src/forge/github/source-plugin.ts')],
      outdir: pluginInstall,
      target: 'bun',
      naming: 'source-plugin.mjs',
    });
    if (!built.success)
      throw new Error(`Plugin build failed: ${built.logs.map(String).join('\n')}`);
    const modulePath = join(pluginInstall, 'source-plugin.mjs');
    const hostConfig = (sourceConfig: JsonValue): JsonValue => ({
      version: 1,
      sources: [
        {
          sourceInstanceId: 'integration-github',
          module: modulePath,
          config: sourceConfig,
        },
      ],
    });
    writeFileSync(forgeConfigPath, JSON.stringify(hostConfig(forgeConfig)));
    const ingressScript = join(root, 'receive.ts');
    writeFileSync(
      ingressScript,
      `
      import { createHmac } from 'node:crypto';
      import { OpenAPIHono } from ${JSON.stringify(import.meta.resolve('@hono/zod-openapi'))};
      import { loadWebhookSourcePlugins } from ${JSON.stringify(join(packagesRoot, 'server/src/services/webhook-source-plugins.ts'))};
      import { registerWebhookSourceRoutes } from ${JSON.stringify(join(packagesRoot, 'server/src/routes/webhooks.ts'))};
      import { closeDatabase } from ${JSON.stringify(join(packagesRoot, 'core/src/db/connection.ts'))};
      import { createSqlWorkflowHost } from ${JSON.stringify(join(packagesRoot, 'core/src/workflows/sql-host.ts'))};
      import { hasStartReceiptForDelivery } from ${JSON.stringify(join(packagesRoot, 'core/src/db/resource-starts.ts'))};
      const workflowHost = createSqlWorkflowHost();
      const host = await loadWebhookSourcePlugins(${JSON.stringify(forgeConfigPath)}, {
        acceptReceipt: workflowHost.deps.store.acceptStartReceipt,
        isKnownUser: async id => (await workflowHost.records.users.getUserById(id)) !== null,
        hasDeliveryReceipt: hasStartReceiptForDelivery,
      });
      const app = new OpenAPIHono();
      registerWebhookSourceRoutes(app, host);
      const payload = JSON.stringify({action:'opened',repository:{full_name:'owner/repo'},
        sender:{id:42},pull_request:{number:9,state:'open',head:{sha:'opaque-revision'}}});
      const signature = 'sha256='+createHmac('sha256','test-secret').update(payload).digest('hex');
      const response = await app.request('/webhooks/sources/integration-github', {
        method: 'POST', body: payload, headers: {
          'x-hub-signature-256': signature, 'x-github-delivery': 'delivery-one', 'x-github-event': 'pull_request',
        },
      });
      if(response.status !== 200) throw Error('Not accepted: '+response.status);
      const changed = payload + ' ';
      const conflict = await app.request('/webhooks/sources/integration-github', {
        method: 'POST', body: changed, headers: {
          'x-hub-signature-256': 'sha256='+createHmac('sha256','test-secret').update(changed).digest('hex'),
          'x-github-delivery': 'delivery-one', 'x-github-event': 'pull_request',
        },
      });
      if(conflict.status !== 409) throw Error('Not a conflict: '+conflict.status);
      await closeDatabase();
    `
    );
    await runCli(ingressScript, projectRoot, archonHome, []);
    // Replaying after a policy edit retains the first resolved binding snapshot.
    writeFileSync(
      forgeConfigPath,
      JSON.stringify(
        hostConfig({
          ...forgeConfig,
          bindings: [
            {
              ...forgeConfig.bindings[0],
              inputMapping: { count: { source: 'literal', value: 999 } },
            },
          ],
        })
      )
    );
    await runCli(ingressScript, projectRoot, archonHome, []);
    const listing = await runCli(cliPath, projectRoot, archonHome, ['trigger', 'list', '--json']);
    expect(JSON.parse(listing.stdout)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceInstanceId: 'integration-github',
          deliveryId: 'delivery-one',
          outcome: 'matched',
        }),
      ])
    );
    expect(
      readRows<{ count: number }>(
        databasePath,
        "SELECT count(*) AS count FROM remote_agent_start_receipts WHERE source_instance_id='integration-github'"
      )[0]?.count
    ).toBe(1);
    await runCli(cliPath, projectRoot, archonHome, [
      'trigger',
      'drain',
      '--host',
      'integration-host',
    ]);
    const forgeRun = await waitFor(() => {
      const rows = readRows<RunRow>(
        databasePath,
        'SELECT id,status,metadata,output_root FROM remote_agent_workflow_runs ORDER BY started_at'
      );
      if (rows[2] && !['completed', 'failed'].includes(rows[2].status)) activeRuns.add(rows[2].id);
      return rows[2]?.status === 'completed' ? rows[2] : undefined;
    }, 'signed forge delivery to execute after host drain');
    activeRuns.delete(forgeRun.id);
    if (!forgeRun.output_root) throw new Error('Forge run has no output root');
    expect(
      readFileSync(
        join(getRunArtifactsDirForRoot(forgeRun.output_root, forgeRun.id), 'result.txt'),
        'utf8'
      ).trim()
    ).toBe('EDITED-9-edited-config');
  }, 45_000);

  test('a bundled Standard Webhooks source authenticates, deduplicates and starts a governed run', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'archon-standard-webhooks-integration-')));
    tempRoots.push(root);
    const archonHome = join(root, 'home');
    const projectRoot = join(root, 'project');
    const workflowsDir = join(projectRoot, '.archon', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(
      join(workflowsDir, 'order.yaml'),
      `name: order
description: Standard Webhooks integration proof.
mutates_checkout: false
inputs:
  count:
    required: true
nodes:
  - id: record
    bash: echo "$INPUTS_COUNT" > "$ARTIFACTS_DIR/result.txt"
`
    );
    // No `inputs:` declaration: a source must not pass event values to it.
    writeFileSync(
      join(workflowsDir, 'plain.yaml'),
      `name: plain
description: Declares no inputs.
mutates_checkout: false
nodes:
  - id: record
    bash: echo plain
`
    );
    const cliPath = resolve(import.meta.dir, '..', 'cli.ts');
    expect(await Bun.spawn(['git', 'init', '-q'], { cwd: projectRoot }).exited).toBe(0);
    const identity = await runCli(cliPath, projectRoot, archonHome, ['trigger', 'whoami']);
    const { runAsUserId } = JSON.parse(identity.stdout) as { runAsUserId: string };
    const databasePath = join(archonHome, 'archon.db');
    const packagesRoot = resolve(import.meta.dir, '../../..');
    const bindingWithoutRevision = {
      bindingId: 'order',
      hostId: 'integration-host',
      runAsUserId,
      resource: 'integration:orders',
      overlap: 'queue',
      launch: {
        cwd: projectRoot,
        workflowName: 'order',
        inputs: { count: 0 },
        isolation: { kind: 'in-place' },
      },
    };
    const standardInstall = join(root, 'installed-standard-webhooks-plugin');
    const standardBuild = await Bun.build({
      entrypoints: [join(packagesRoot, 'adapters/src/sources/standard-webhooks/source-plugin.ts')],
      outdir: standardInstall,
      target: 'bun',
      naming: 'source-plugin.mjs',
    });
    if (!standardBuild.success) throw new Error(standardBuild.logs.map(String).join('\n'));
    const standardConfigPath = join(root, 'standard-webhooks.json');
    writeFileSync(
      standardConfigPath,
      JSON.stringify({
        version: 1,
        sources: [
          {
            sourceInstanceId: 'integration-orders',
            module: join(standardInstall, 'source-plugin.mjs'),
            config: {
              version: 1,
              signingSecretEnv: 'ARCHON_STANDARD_WEBHOOKS_TEST_SECRET',
              bindings: [
                {
                  ...bindingWithoutRevision,
                  bindingId: 'order',
                  inputMapping: { count: '/order/count' },
                },
                {
                  ...bindingWithoutRevision,
                  bindingId: 'undeclared',
                  inputMapping: { undeclared: '/order/count' },
                },
                {
                  ...bindingWithoutRevision,
                  bindingId: 'undeclared-workflow',
                  resource: 'integration:plain',
                  launch: { ...bindingWithoutRevision.launch, workflowName: 'plain', inputs: {} },
                  inputMapping: { count: '/order/count' },
                },
              ],
            },
          },
        ],
      })
    );
    const standardScript = join(root, 'receive-standard.ts');
    writeFileSync(
      standardScript,
      `
      import { createHmac } from 'node:crypto';
      import { OpenAPIHono } from ${JSON.stringify(import.meta.resolve('@hono/zod-openapi'))};
      import { loadWebhookSourcePlugins } from ${JSON.stringify(join(packagesRoot, 'server/src/services/webhook-source-plugins.ts'))};
      import { registerWebhookSourceRoutes } from ${JSON.stringify(join(packagesRoot, 'server/src/routes/webhooks.ts'))};
      import { closeDatabase } from ${JSON.stringify(join(packagesRoot, 'core/src/db/connection.ts'))};
      import { createSqlWorkflowHost } from ${JSON.stringify(join(packagesRoot, 'core/src/workflows/sql-host.ts'))};
      import { hasStartReceiptForDelivery } from ${JSON.stringify(join(packagesRoot, 'core/src/db/resource-starts.ts'))};
      const workflowHost = createSqlWorkflowHost();
      process.env.ARCHON_STANDARD_WEBHOOKS_TEST_SECRET = 'whsec_' + Buffer.from('test-secret').toString('base64');
      let runAsUserRemoved = false;
      const host = await loadWebhookSourcePlugins(${JSON.stringify(standardConfigPath)}, {
        acceptReceipt: workflowHost.deps.store.acceptStartReceipt,
        isKnownUser: async id => !runAsUserRemoved && (await workflowHost.records.users.getUserById(id)) !== null,
        hasDeliveryReceipt: hasStartReceiptForDelivery,
      });
      const app = new OpenAPIHono();
      registerWebhookSourceRoutes(app, host);
      const payload = JSON.stringify({order:{count:12},workflowName:'evil',cwd:'/evil',runAsUserId:'evil',hostId:'evil',resource:'evil',isolation:{kind:'worktree'}});
      const id = 'order-one';
      const timestamp = String(Math.floor(Date.now()/1000));
      const headers = (body, ts = timestamp, deliveryId = id) => ({
        'webhook-id': deliveryId, 'webhook-timestamp': ts,
        'webhook-signature': 'v1,'+createHmac('sha256','test-secret').update(deliveryId+'.'+ts+'.'+body).digest('base64'),
      });
      const post = async (body, hdrs, expected) => {
        // Bytes, as on the wire: Bun keeps a string body's BOM in text() where HTTP bytes lose it.
        const response = await app.request('/webhooks/sources/integration-orders', {method:'POST',body:new TextEncoder().encode(body),headers:hdrs});
        if(response.status !== expected) throw Error('Expected '+expected+', got '+response.status+' for '+hdrs['webhook-id']+' '+JSON.stringify(body.slice(0,12)));
      };
      await post(payload, {}, 401);
      await post(payload+' ', headers(payload), 401);
      await post(payload, headers(payload, String(Number(timestamp)-301)), 401);
      // A UTF-8 BOM is part of the received bytes: prefixing one changes the signed content.
      await post('\\uFEFF'+payload, headers(payload), 401);
      if ((await workflowHost.deps.store.listStartReceipts()).some(r => r.sourceInstanceId === 'integration-orders')) throw Error('Unauthenticated receipt persisted');
      await post(payload, headers(payload), 200);
      // A replay keeps its first acceptance even when today's run-as check would fail.
      runAsUserRemoved = true;
      await post(payload, headers(payload), 200);
      runAsUserRemoved = false;
      // Signed with its BOM, the delivery authenticates; JSON forbids a BOM, so it is malformed.
      const bomBody = '\\uFEFF'+JSON.stringify({order:{count:1}});
      await post(bomBody, headers(bomBody, timestamp, 'bom-one'), 400);
      const changed = JSON.stringify({order:{count:13}});
      await post(changed, headers(changed), 409);
      await closeDatabase();
    `
    );
    await runCli(standardScript, projectRoot, archonHome, []);
    expect(
      readRows<{ delivery_id: string; outcome: string }>(
        databasePath,
        "SELECT delivery_id, outcome FROM remote_agent_start_receipts WHERE source_instance_id='integration-orders' ORDER BY delivery_id"
      )
    ).toEqual([
      { delivery_id: 'bom-one', outcome: 'malformed' },
      { delivery_id: 'order-one', outcome: 'matched' },
    ]);
    const drained = await runCli(
      cliPath,
      projectRoot,
      archonHome,
      ['trigger', 'drain', '--host', 'integration-host'],
      false
    );
    expect(drained.exitCode).toBe(1);
    expect(
      readRows(
        databasePath,
        'SELECT binding_id,preparation_status FROM remote_agent_start_receipt_bindings ORDER BY binding_id'
      )
    ).toEqual([
      { binding_id: 'order', preparation_status: 'complete' },
      { binding_id: 'undeclared', preparation_status: 'rejected' },
      { binding_id: 'undeclared-workflow', preparation_status: 'rejected' },
    ]);

    const standardRun = await waitFor(() => {
      const rows = readRows<RunRow>(
        databasePath,
        'SELECT id,status,metadata,output_root FROM remote_agent_workflow_runs ORDER BY started_at'
      );
      if (rows[0] && !['completed', 'failed'].includes(rows[0].status)) activeRuns.add(rows[0].id);
      return rows[0]?.status === 'completed' ? rows[0] : undefined;
    }, 'signed Standard Webhooks delivery to execute after host drain');
    activeRuns.delete(standardRun.id);
    expect(JSON.parse(standardRun.metadata)).toMatchObject({ inputs_values: { count: 12 } });
    if (!standardRun.output_root) throw new Error('Standard Webhooks run has no output root');
    expect(
      readFileSync(
        join(getRunArtifactsDirForRoot(standardRun.output_root, standardRun.id), 'result.txt'),
        'utf8'
      ).trim()
    ).toBe('12');
    expect(
      readRows<RequestRow>(
        databasePath,
        'SELECT id,status,launch FROM remote_agent_resource_start_requests'
      )
    ).toHaveLength(1);
  }, 30_000);

  // Windows has no POSIX signal delivery, and Git Bash's $PPID is an MSYS PID, not a Windows one.
  test.skipIf(process.platform === 'win32')(
    'a graceful signal settles the owned run so its resource slot admits the next start',
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'archon-trigger-signal-')));
      tempRoots.push(root);
      const archonHome = join(root, 'home');
      const projectRoot = join(root, 'project');
      const workflowPath = join(projectRoot, '.archon', 'workflows', 'signal-proof.yaml');
      mkdirSync(join(projectRoot, '.archon', 'workflows'), { recursive: true });
      expect(await Bun.spawn(['git', 'init', '-q'], { cwd: projectRoot }).exited).toBe(0);
      const pidFile = join(root, 'owner.pid');
      // A bash node's parent is the `trigger execute` process that owns the run.
      const writeWorkflow = (body: string): void => {
        writeFileSync(
          workflowPath,
          `name: signal-proof\ndescription: Signal proof.\nmutates_checkout: false\nnodes:\n  - id: hold\n    bash: |\n      ${body}\n`
        );
      };
      writeWorkflow(`echo "$PPID $$" > '${pidFile}'; exec sleep 60`);

      const cliPath = resolve(import.meta.dir, '..', 'cli.ts');
      const databasePath = join(archonHome, 'archon.db');
      const userId = crypto.randomUUID();
      const configPath = join(root, 'trigger.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          version: 1,
          sourceInstanceId: 'signal-timer',
          binding: {
            bindingId: 'signal-proof',
            bindingRevision: null,
            hostId: 'signal-host',
            runAsUserId: userId,
            resource: 'signal:resource',
            overlap: 'queue',
            launch: {
              cwd: projectRoot,
              workflowName: 'signal-proof',
              inputs: {},
              isolation: { kind: 'in-place' },
            },
          },
          schedule: { intervalSeconds: 60, runAtLoad: false },
        })
      );
      const fire = ['trigger', 'fire', '--config', configPath];
      expect((await runCli(cliPath, projectRoot, archonHome, fire, false)).exitCode).not.toBe(0);
      const database = new Database(databasePath);
      try {
        database
          .query('INSERT INTO remote_agent_users (id, display_name) VALUES (?, ?)')
          .run(userId, 'Signal actor');
      } finally {
        database.close();
      }
      const runs = (): RunRow[] =>
        readRows<RunRow>(
          databasePath,
          'SELECT id,status,metadata,output_root FROM remote_agent_workflow_runs ORDER BY started_at'
        );

      let sleepPid: number | undefined;
      try {
        await runCli(cliPath, projectRoot, archonHome, fire);
        const [ownerPid, nodePid] = await waitFor(() => {
          if (runs()[0]?.status !== 'running' || !existsSync(pidFile)) return undefined;
          const pids = readFileSync(pidFile, 'utf8').trim().split(' ').map(Number);
          return pids.length === 2 ? pids : undefined;
        }, 'trigger execution to start its node');
        sleepPid = nodePid;

        process.kill(ownerPid, 'SIGTERM');
        const failed = await waitFor(() => {
          const run = runs()[0];
          return run?.status === 'failed' ? run : undefined;
        }, 'signalled run to settle as failed');
        expect(JSON.parse(failed.metadata)).toMatchObject({
          error: 'Process terminated (SIGTERM)',
        });
        await waitFor(() => {
          try {
            process.kill(ownerPid, 0);
            return undefined;
          } catch {
            return true;
          }
        }, 'signalled owner to exit');

        // With the run terminal, the capacity-1 slot admits the next start at once.
        writeWorkflow('echo done');
        await runCli(cliPath, projectRoot, archonHome, fire);
        await waitFor(
          () => (runs()[1]?.status === 'completed' ? true : undefined),
          'next start to run'
        );
        expect(
          readRows<RequestRow>(
            databasePath,
            'SELECT id,status,launch FROM remote_agent_resource_start_requests ORDER BY queue_position'
          ).map(row => row.status)
        ).toEqual(['admitted', 'admitted']);
      } finally {
        if (sleepPid !== undefined) {
          try {
            process.kill(sleepPid, 'SIGKILL');
          } catch {
            // Already gone.
          }
        }
      }
    },
    45_000
  );

  test('workflow cancel stops a run executing in a detached trigger execute process', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'archon-trigger-cancel-')));
    tempRoots.push(root);
    const archonHome = join(root, 'home');
    const projectRoot = join(root, 'project');
    const workflowPath = join(projectRoot, '.archon', 'workflows', 'cancel-proof.yaml');
    mkdirSync(join(projectRoot, '.archon', 'workflows'), { recursive: true });
    expect(await Bun.spawn(['git', 'init', '-q'], { cwd: projectRoot }).exited).toBe(0);
    const pidFile = join(root, 'owner.pid');
    const writeWorkflow = (body: string): void => {
      writeFileSync(
        workflowPath,
        `name: cancel-proof\ndescription: Cancel proof.\nmutates_checkout: false\nnodes:\n  - id: hold\n    bash: |\n      ${body}\n`
      );
    };
    // A bash node's parent is the `trigger execute` process that owns the run.
    writeWorkflow(`echo "$PPID $$" > '${pidFile}'; exec sleep 60`);

    const cliPath = resolve(import.meta.dir, '..', 'cli.ts');
    const databasePath = join(archonHome, 'archon.db');
    const userId = crypto.randomUUID();
    const configPath = join(root, 'trigger.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        sourceInstanceId: 'cancel-timer',
        binding: {
          bindingId: 'cancel-proof',
          bindingRevision: null,
          hostId: 'cancel-host',
          runAsUserId: userId,
          resource: 'cancel:resource',
          overlap: 'queue',
          launch: {
            cwd: projectRoot,
            workflowName: 'cancel-proof',
            inputs: {},
            isolation: { kind: 'in-place' },
          },
        },
        schedule: { intervalSeconds: 60, runAtLoad: false },
      })
    );
    const fire = ['trigger', 'fire', '--config', configPath];
    expect((await runCli(cliPath, projectRoot, archonHome, fire, false)).exitCode).not.toBe(0);
    const database = new Database(databasePath);
    try {
      database
        .query('INSERT INTO remote_agent_users (id, display_name) VALUES (?, ?)')
        .run(userId, 'Cancel actor');
    } finally {
      database.close();
    }
    const runs = (): RunRow[] =>
      readRows<RunRow>(
        databasePath,
        'SELECT id,status,metadata,output_root FROM remote_agent_workflow_runs ORDER BY started_at'
      );
    const requests = (): RequestRow[] =>
      readRows<RequestRow>(
        databasePath,
        'SELECT id,status,launch FROM remote_agent_resource_start_requests ORDER BY queue_position'
      );

    let pids: number[] = [];
    try {
      await runCli(cliPath, projectRoot, archonHome, fire);
      const first = await waitFor(() => {
        const run = runs()[0];
        return run?.status === 'running' ? run : undefined;
      }, 'trigger execution to start');
      activeRuns.add(first.id);
      // The node writes both PIDs with one echo, but the file can exist before the write
      // finishes. Parse only a complete record, so a partial read never yields PID 0,
      // which the cleanup below would turn into a signal to this runner's own group.
      pids = await waitFor(() => {
        if (!existsSync(pidFile)) return undefined;
        const record = readFileSync(pidFile, 'utf8').trim().split(' ').map(Number);
        return record.length === 2 && record.every(pid => Number.isInteger(pid) && pid > 0)
          ? record
          : undefined;
      }, 'trigger node to record its PIDs');

      // The next start captures its own source at intake and waits behind the slot.
      writeWorkflow('echo done');
      await runCli(cliPath, projectRoot, archonHome, fire);
      await waitFor(
        () => (requests()[1]?.status === 'queued' ? true : undefined),
        'second start to queue behind the running one'
      );

      const cancel = await runCli(
        cliPath,
        projectRoot,
        archonHome,
        ['workflow', 'cancel', first.id],
        false
      );
      if (cancel.exitCode !== 0) {
        throw new Error(`cancel failed: ${cancel.stderr || cancel.stdout}`);
      }
      activeRuns.delete(first.id);
      expect(runs()[0]?.status).toBe('cancelled');
      // Git Bash reports MSYS PIDs on Windows, so the PID check is POSIX-only; there the
      // cancel command's own confirmation that the owner's tree stopped is the proof.
      if (process.platform !== 'win32') {
        for (const pid of pids) expect(processAlive(pid)).toBe(false);
      }

      // The cancelled run released the capacity-1 slot, so a drain admits the queue.
      await runCli(cliPath, projectRoot, archonHome, ['trigger', 'drain', '--host', 'cancel-host']);
      await waitFor(
        () => (runs()[1]?.status === 'completed' ? true : undefined),
        'queued start to run after the cancel'
      );
      expect(requests().map(row => row.status)).toEqual(['admitted', 'admitted']);
    } finally {
      if (process.platform !== 'win32') {
        for (const pid of pids.filter(pid => pid > 0)) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // Already gone.
          }
        }
      }
    }
  }, 45_000);

  /**
   * A trigger binding on a capacity-1 resource whose run holds its node in `sleep`, in a
   * scratch ARCHON_HOME. `fire()` starts a detached `trigger execute` owner; the bash
   * node records `$PPID $$`, which is that owner and the node. `holdPrefix` runs first
   * in the node's shell.
   */
  async function heldTriggerRun(
    label: string,
    holdPrefix = ''
  ): Promise<{
    projectRoot: string;
    archonHome: string;
    cliPath: string;
    hostId: string;
    pidFile: string;
    writeWorkflow: (body: string) => void;
    fire: () => Promise<void>;
    runs: () => RunRow[];
    requests: () => RequestRow[];
  }> {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `archon-trigger-${label}-`)));
    tempRoots.push(root);
    const archonHome = join(root, 'home');
    const projectRoot = join(root, 'project');
    const workflowPath = join(projectRoot, '.archon', 'workflows', `${label}-proof.yaml`);
    mkdirSync(join(projectRoot, '.archon', 'workflows'), { recursive: true });
    expect(await Bun.spawn(['git', 'init', '-q'], { cwd: projectRoot }).exited).toBe(0);
    const pidFile = join(root, 'owner.pid');
    const writeWorkflow = (body: string): void => {
      writeFileSync(
        workflowPath,
        `name: ${label}-proof\ndescription: ${label} proof.\nmutates_checkout: false\nnodes:\n  - id: hold\n    bash: |\n      ${body}\n`
      );
    };
    writeWorkflow(`${holdPrefix}echo "$PPID $$" > '${pidFile}'; exec sleep 60`);

    const cliPath = resolve(import.meta.dir, '..', 'cli.ts');
    const databasePath = join(archonHome, 'archon.db');
    const userId = crypto.randomUUID();
    const hostId = `${label}-host`;
    const configPath = join(root, 'trigger.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        sourceInstanceId: `${label}-timer`,
        binding: {
          bindingId: `${label}-proof`,
          bindingRevision: null,
          hostId,
          runAsUserId: userId,
          resource: `${label}:resource`,
          overlap: 'queue',
          launch: {
            cwd: projectRoot,
            workflowName: `${label}-proof`,
            inputs: {},
            isolation: { kind: 'in-place' },
          },
        },
        schedule: { intervalSeconds: 60, runAtLoad: false },
      })
    );
    const fireArgs = ['trigger', 'fire', '--config', configPath];
    // The first DB-backed command creates the scratch schema, then fails closed because
    // the configured actor does not exist yet. Seed only that actor.
    expect((await runCli(cliPath, projectRoot, archonHome, fireArgs, false)).exitCode).not.toBe(0);
    const database = new Database(databasePath);
    try {
      database
        .query('INSERT INTO remote_agent_users (id, display_name) VALUES (?, ?)')
        .run(userId, `${label} actor`);
    } finally {
      database.close();
    }
    return {
      projectRoot,
      archonHome,
      cliPath,
      hostId,
      pidFile,
      writeWorkflow,
      fire: async (): Promise<void> => {
        await runCli(cliPath, projectRoot, archonHome, fireArgs);
      },
      runs: (): RunRow[] =>
        readRows<RunRow>(
          databasePath,
          'SELECT id,status,metadata,output_root FROM remote_agent_workflow_runs ORDER BY started_at'
        ),
      requests: (): RequestRow[] =>
        readRows<RequestRow>(
          databasePath,
          'SELECT id,status,launch FROM remote_agent_resource_start_requests ORDER BY queue_position'
        ),
    };
  }

  /** Both PIDs the held node records, parsed only from a complete record (never PID 0). */
  function recordedPids(pidFile: string): Promise<[owner: number, node: number]> {
    return waitFor(() => {
      if (!existsSync(pidFile)) return undefined;
      const record = readFileSync(pidFile, 'utf8').trim().split(' ').map(Number);
      return record.length === 2 && record.every(pid => Number.isInteger(pid) && pid > 0)
        ? ([record[0], record[1]] as [number, number])
        : undefined;
    }, 'trigger node to record its PIDs');
  }

  function killAll(pids: number[]): void {
    if (process.platform === 'win32') return;
    for (const pid of pids.filter(pid => pid > 0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }

  test('workflow abandon stops a live detached owner before the queued start is admitted', async () => {
    // The held node ignores SIGTERM, so its process group outlives the terminator's
    // first signal until the SIGKILL escalation. That keeps a wrong order (cancelled
    // before the tree is gone) visible for seconds instead of milliseconds.
    const fixture = await heldTriggerRun('abandon', "trap '' TERM; ");
    let pids: number[] = [];
    try {
      await fixture.fire();
      const first = await waitFor(() => {
        const run = fixture.runs()[0];
        return run?.status === 'running' ? run : undefined;
      }, 'trigger execution to start');
      activeRuns.add(first.id);
      pids = await recordedPids(fixture.pidFile);
      const [ownerPid] = pids;

      // The next start waits behind the slot. A drain while the owner is alive must
      // leave it queued: the slot is still held.
      fixture.writeWorkflow('echo done');
      await fixture.fire();
      await waitFor(
        () => (fixture.requests()[1]?.status === 'queued' ? true : undefined),
        'second start to queue behind the running one'
      );
      await runCli(fixture.cliPath, fixture.projectRoot, fixture.archonHome, [
        'trigger',
        'drain',
        '--host',
        fixture.hostId,
      ]);
      expect(fixture.requests()[1]?.status).toBe('queued');

      // Watch the row while abandon runs. `cancelled` is what releases the slot, so it
      // must never be visible while the owner or its node is still alive. PIDs are MSYS
      // values under Git Bash, so the watch is POSIX-only.
      let watching = true;
      let releasedWhileOwnerAlive = false;
      const watch = (async (): Promise<void> => {
        while (watching) {
          if (
            process.platform !== 'win32' &&
            fixture.runs()[0]?.status === 'cancelled' &&
            pids.some(processAlive)
          ) {
            releasedWhileOwnerAlive = true;
          }
          await Bun.sleep(10);
        }
      })();
      const abandon = await runCli(
        fixture.cliPath,
        fixture.projectRoot,
        fixture.archonHome,
        ['workflow', 'abandon', first.id],
        false
      );
      watching = false;
      await watch;
      if (abandon.exitCode !== 0) {
        throw new Error(`abandon failed: ${abandon.stderr || abandon.stdout}`);
      }
      activeRuns.delete(first.id);

      expect(releasedWhileOwnerAlive).toBe(false);
      expect(fixture.runs()[0]?.status).toBe('cancelled');
      expect(abandon.stdout).toContain("Stopped the run's live owner process");
      if (process.platform !== 'win32') {
        expect(abandon.stdout).toContain(`(pid ${String(ownerPid)})`);
        for (const pid of pids) expect(processAlive(pid)).toBe(false);
      }

      // With the owner gone and the run cancelled, the queued start is admitted.
      await runCli(fixture.cliPath, fixture.projectRoot, fixture.archonHome, [
        'trigger',
        'drain',
        '--host',
        fixture.hostId,
      ]);
      await waitFor(
        () => (fixture.runs()[1]?.status === 'completed' ? true : undefined),
        'queued start to run after the abandon'
      );
      expect(fixture.requests().map(row => row.status)).toEqual(['admitted', 'admitted']);
    } finally {
      killAll(pids);
    }
  }, 60_000);

  /**
   * Cancel through the shared op from a separate process that does not own the run, the
   * way the server's API route, chat `/workflow cancel`, Slack, and `manage_run` do.
   */
  async function serverSideCancel(
    fixture: { projectRoot: string; archonHome: string },
    runId: string
  ): Promise<{ ok: boolean; kind?: string; pid?: number; reason?: string; message?: string }> {
    const script = resolve(import.meta.dir, '..', 'utils', 'fixtures', 'cancel-run.ts');
    const result = await runCli(script, fixture.projectRoot, fixture.archonHome, [runId]);
    const line = result.stdout.trim().split('\n').at(-1) ?? '';
    return JSON.parse(line) as {
      ok: boolean;
      kind?: string;
      pid?: number;
      reason?: string;
      message?: string;
    };
  }

  test('server-side cancel stops a live detached owner before the queued start is admitted', async () => {
    // Same shape as the abandon spec above: the held node ignores SIGTERM, so a wrong
    // order (cancelled before the tree is gone) stays visible until the SIGKILL.
    const fixture = await heldTriggerRun('cancel', "trap '' TERM; ");
    let pids: number[] = [];
    try {
      await fixture.fire();
      const first = await waitFor(() => {
        const run = fixture.runs()[0];
        return run?.status === 'running' ? run : undefined;
      }, 'trigger execution to start');
      activeRuns.add(first.id);
      pids = await recordedPids(fixture.pidFile);
      const [ownerPid] = pids;

      fixture.writeWorkflow('echo done');
      await fixture.fire();
      await waitFor(
        () => (fixture.requests()[1]?.status === 'queued' ? true : undefined),
        'second start to queue behind the running one'
      );

      let watching = true;
      let releasedWhileOwnerAlive = false;
      const watch = (async (): Promise<void> => {
        while (watching) {
          if (
            process.platform !== 'win32' &&
            fixture.runs()[0]?.status === 'cancelled' &&
            pids.some(processAlive)
          ) {
            releasedWhileOwnerAlive = true;
          }
          await Bun.sleep(10);
        }
      })();
      const cancel = await serverSideCancel(fixture, first.id);
      watching = false;
      await watch;
      if (!cancel.ok) throw new Error(`cancel refused: ${String(cancel.message)}`);
      activeRuns.delete(first.id);

      expect(cancel.kind).toBe('stopped');
      expect(releasedWhileOwnerAlive).toBe(false);
      expect(fixture.runs()[0]?.status).toBe('cancelled');
      if (process.platform !== 'win32') {
        expect(cancel.pid).toBe(ownerPid);
        for (const pid of pids) expect(processAlive(pid)).toBe(false);
      }

      await runCli(fixture.cliPath, fixture.projectRoot, fixture.archonHome, [
        'trigger',
        'drain',
        '--host',
        fixture.hostId,
      ]);
      await waitFor(
        () => (fixture.runs()[1]?.status === 'completed' ? true : undefined),
        'queued start to run after the cancel'
      );
    } finally {
      killAll(pids);
    }
  }, 60_000);

  test.skipIf(process.platform === 'win32')(
    'server-side cancel of an owner that is gone refuses and leaves the run holding its slot',
    async () => {
      const fixture = await heldTriggerRun('cancel-orphan');
      let pids: number[] = [];
      try {
        await fixture.fire();
        const first = await waitFor(() => {
          const run = fixture.runs()[0];
          return run?.status === 'running' ? run : undefined;
        }, 'trigger execution to start');
        pids = await recordedPids(fixture.pidFile);
        const [ownerPid] = pids;
        process.kill(ownerPid, 'SIGKILL');
        await waitFor(() => (processAlive(ownerPid) ? undefined : true), 'owner to die');

        const cancel = await serverSideCancel(fixture, first.id);

        expect(cancel).toMatchObject({ ok: false, reason: 'no_owner_answered' });
        expect(cancel.message).toContain(
          `Recorded owner: host ${hostname()}, pid ${String(ownerPid)}.`
        );
        expect(fixture.runs()[0]?.status).toBe('running');
      } finally {
        killAll(pids);
      }
    },
    60_000
  );

  // An owner killed outright leaves a socket nobody listens on, which is the unreachable
  // case. SIGKILL and real PIDs are POSIX-only.
  test.skipIf(process.platform === 'win32')(
    'workflow abandon of an owner that is gone prints what the run recorded, then cancels',
    async () => {
      const fixture = await heldTriggerRun('orphan');
      let pids: number[] = [];
      try {
        await fixture.fire();
        const first = await waitFor(() => {
          const run = fixture.runs()[0];
          return run?.status === 'running' ? run : undefined;
        }, 'trigger execution to start');
        pids = await recordedPids(fixture.pidFile);
        const [ownerPid] = pids;

        process.kill(ownerPid, 'SIGKILL');
        await waitFor(() => (processAlive(ownerPid) ? undefined : true), 'owner to die');
        // Nothing settled the row: SIGKILL gives the owner no chance to.
        expect(fixture.runs()[0]?.status).toBe('running');

        const abandon = await runCli(fixture.cliPath, fixture.projectRoot, fixture.archonHome, [
          'workflow',
          'abandon',
          first.id,
        ]);

        expect(abandon.stdout).toContain(
          `No live owner answered for this run on this host (${hostname()}; `
        );
        expect(abandon.stdout).toContain(
          `Recorded owner: host ${hostname()}, pid ${String(ownerPid)}.`
        );
        expect(abandon.stdout).toMatch(/Last activity: \d{4}-\d{2}-\d{2}T/);
        expect(abandon.stdout).not.toContain('another host');
        expect(fixture.runs()[0]?.status).toBe('cancelled');
      } finally {
        killAll(pids);
      }
    },
    60_000
  );
});

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
