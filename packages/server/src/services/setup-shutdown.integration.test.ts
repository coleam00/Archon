import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileAsync } from '@archon/git';
import { trackTempRoots } from '@archon/paths/test-utils';

const trackTempRoot = trackTempRoots();

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for server setup shutdown');
    await Bun.sleep(25);
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

test.skipIf(process.platform === 'win32')(
  'server SIGTERM shutdown ends a resource-start setup descendant before cleanup',
  async () => {
    const root = trackTempRoot(await realpath(mkdtempSync(join(tmpdir(), 'archon-setup-server-'))));
    const project = join(root, 'project');
    const home = join(root, 'home');
    await mkdir(join(project, '.archon', 'workflows'), { recursive: true });
    await mkdir(home);
    await writeFile(join(home, 'config.yaml'), 'defaultAssistant: claude\n');
    await writeFile(
      join(project, '.archon', 'workflows', 'hosted.yaml'),
      'name: hosted\ndescription: Shutdown test.\nnodes:\n  - id: one\n    bash: echo one\n'
    );
    const descendant = `echo $$ > '${root}/descendant.pid'; touch '${root}/ready'; while [ ! -f '${root}/go' ]; do sleep 0.01; done; touch '${root}/leaked'`;
    await writeFile(
      join(project, '.archon', 'config.yaml'),
      `worktree:\n  postCreateTimeout: 120000\n  postCreate:\n    - ${JSON.stringify(`bash -c "${descendant}" & wait`)}\n`
    );
    const origin = join(root, 'origin.git');
    for (const args of [
      ['init', '-q', '--bare', '-b', 'main', origin],
      ['init', '-q', '-b', 'main'],
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base'],
      ['remote', 'add', 'origin', origin],
      ['push', '-q', 'origin', 'main'],
      ['remote', 'set-head', 'origin', 'main'],
    ])
      await execFileAsync('git', args, { cwd: project });

    const modulePath = join(root, 'plugin.mjs');
    await writeFile(
      modulePath,
      `export default ({ sourceInstanceId, config }) => ({
      async receive(request) {
        return { status: 'received', acceptance: {
          receipt: { id: crypto.randomUUID(), sourceInstanceId, deliveryId: 'shutdown',
            contentDigest: 'sha256:shutdown', receivedAt: request.receivedAt,
            occurredAt: null, sourceActor: null },
          outcome: 'matched', bindings: [config.binding]
        }};
      }
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
                hostId: 'server-host',
                runAsUserId: '22222222-2222-4222-8222-222222222222',
                resource: 'repo:hosted',
                capacity: 1,
                overlap: 'queue',
                launch: {
                  cwd: project,
                  workflowName: 'hosted',
                  inputs: {},
                  isolation: { kind: 'worktree' },
                },
              },
            },
          },
        ],
      })
    );
    const server = spawn(
      process.execPath,
      [join(import.meta.dir, 'fixtures/setup-shutdown-server.ts'), root],
      {
        cwd: project,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ARCHON_HOME: home,
          DATABASE_URL: '',
          ARCHON_TELEMETRY_DISABLED: '1',
          HOST: '127.0.0.1',
          ARCHON_TRIGGER_HOST: 'server-host',
          ARCHON_WEBHOOK_SOURCES: configPath,
        },
      }
    );
    let output = '';
    server.stdout?.on('data', chunk => {
      output += String(chunk);
    });
    server.stderr?.on('data', chunk => {
      output += String(chunk);
    });
    const exited = new Promise<void>(resolve => server.once('exit', () => resolve()));
    const ready = (file: string): boolean => {
      if (server.exitCode !== null || server.signalCode !== null) throw new Error(output);
      return existsSync(join(root, file));
    };
    try {
      await waitFor(() => ready('server.port'));
      const port = Number(readFileSync(join(root, 'server.port'), 'utf8'));
      const response = await fetch(`http://127.0.0.1:${port}/webhooks/sources/events`, {
        method: 'POST',
        body: '{}',
      });
      expect(response.status).toBe(200);
      await waitFor(() => ready('ready'));
      const descendantPid = Number(readFileSync(join(root, 'descendant.pid'), 'utf8'));
      expect(processExists(descendantPid)).toBe(true);
      server.kill('SIGTERM');
      await waitFor(() => server.exitCode !== null || server.signalCode !== null);
      await exited;
      expect(server.exitCode).toBe(0);
      expect(server.signalCode).toBeNull();
      expect(output).toContain('database_pool_closed');
      await waitFor(() => !processExists(descendantPid));
      writeFileSync(join(root, 'go'), '');
      expect(existsSync(join(root, 'leaked'))).toBe(false);
    } finally {
      server.kill('SIGKILL');
      await exited;
      // Release a survivor when running this regression against the old executor.
      writeFileSync(join(root, 'go'), '');
      await Bun.sleep(100);
    }
  },
  90_000
);
