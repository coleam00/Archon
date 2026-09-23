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
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { JsonValue } from '@archon/workflows/output-ref';
import { getRunArtifactsDirForRoot } from '@archon/paths';
import { removeTempTree } from '@archon/paths/test-utils';
import { requestDetachedRunStop } from '../utils/detached-run-control';

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
  status: string;
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

function workflow(marker: string): string {
  return `name: queued-trigger-proof
description: Durable trigger source proof.
mutates_checkout: false
inputs:
  count:
    required: true
nodes:
  - id: hold
    bash: |
      sleep 8
      echo "${marker}-$INPUTS_COUNT-$TRIGGER_CONFIG_PROOF" > "$ARTIFACTS_DIR/result.txt"
`;
}

describe('trigger CLI durable execution', () => {
  test('cold-drains typed queued work from its frozen source after every launcher exits', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'archon-trigger-integration-')));
    tempRoots.push(root);
    const archonHome = join(root, 'home');
    const projectRoot = join(root, 'project');
    const workflowsDir = join(projectRoot, '.archon', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'queued-trigger-proof.yaml'), workflow('ORIGINAL'));
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

    await runCli(cliPath, projectRoot, archonHome, ['trigger', 'fire', '--config', configPath]);
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
    writeFileSync(join(workflowsDir, 'queued-trigger-proof.yaml'), workflow('EDITED'));
    writeFileSync(
      runConfigPath,
      JSON.stringify({ env: { TRIGGER_CONFIG_PROOF: 'edited-config' } })
    );
    await waitFor(() => {
      const row = readRows<RunRow>(
        databasePath,
        `SELECT id,status,metadata,output_root FROM remote_agent_workflow_runs WHERE id='${firstRun.id}'`
      )[0];
      return row?.status === 'completed' ? row : undefined;
    }, 'first trigger run to complete');
    activeRuns.delete(firstRun.id);

    await runCli(cliPath, projectRoot, archonHome, [
      'trigger',
      'drain',
      '--host',
      'integration-host',
    ]);
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
      const host = await loadWebhookSourcePlugins(${JSON.stringify(forgeConfigPath)});
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
});

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
