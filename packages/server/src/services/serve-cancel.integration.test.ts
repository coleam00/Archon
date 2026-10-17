import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileAsync } from '@archon/git';
import { trackTempRoots } from '@archon/paths/test-utils';

const trackTempRoot = trackTempRoots();
// Long enough that a cancel reaches the first run before its grandchild would finish.
const GRANDCHILD_LIFETIME_MS = 8_000;
// Two in-place runs in one checkout serialize, so each run gets its own project and source.
const SOURCES = ['first', 'second'] as const;

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

test('cancelling a run under archon serve ends its script node tree and no other run', async () => {
  const root = trackTempRoot(await realpath(mkdtempSync(join(tmpdir(), 'archon-serve-cancel-'))));
  const home = join(root, 'home');
  const markers = join(root, 'markers');
  await mkdir(home);
  await mkdir(markers);
  await writeFile(join(home, 'config.yaml'), 'defaultAssistant: claude\n');
  const grandchild = join(root, 'grandchild.js');
  await writeFile(
    grandchild,
    `const { writeFileSync } = require('node:fs');
writeFileSync(process.argv[2], '');
setTimeout(() => writeFileSync(process.argv[3], ''), ${String(GRANDCHILD_LIFETIME_MS)});\n`
  );
  const modulePath = join(root, 'plugin.mjs');
  await writeFile(
    modulePath,
    `export default ({ sourceInstanceId, config }) => ({
      async receive(request) {
        return { status: 'received', acceptance: {
          receipt: { id: crypto.randomUUID(), sourceInstanceId, deliveryId: 'cancel',
            contentDigest: 'sha256:cancel', receivedAt: request.receivedAt,
            occurredAt: null, sourceActor: null },
          outcome: 'matched', bindings: [config.binding]
        }};
      }
    });\n`
  );
  const sources = [];
  for (const name of SOURCES) {
    const project = join(root, name);
    await mkdir(join(project, '.archon', 'workflows'), { recursive: true });
    // The node waits on a grandchild, so only ending the node's whole tree stops its marker.
    await writeFile(
      join(project, '.archon', 'workflows', 'hosted.yaml'),
      `name: hosted
description: Serve cancel test.
nodes:
  - id: hang
    runtime: bun
    script: |
      import { spawn } from 'node:child_process';
      import { join } from 'node:path';
      const marker = name => join(${JSON.stringify(markers)}, process.env.WORKFLOW_ID + '.' + name);
      const child = spawn(process.execPath, [${JSON.stringify(grandchild)}, marker('started'), marker('leaked')], { stdio: 'ignore' });
      await new Promise(resolve => child.once('exit', resolve));
`
    );
    // A resource start runs only in a registered repository.
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: project });
    sources.push({
      sourceInstanceId: name,
      module: modulePath,
      config: {
        binding: {
          bindingId: name,
          bindingRevision: null,
          hostId: 'server-host',
          runAsUserId: '22222222-2222-4222-8222-222222222222',
          resource: `repo:${name}`,
          capacity: 1,
          overlap: 'queue',
          launch: {
            cwd: project,
            workflowName: 'hosted',
            inputs: {},
            isolation: { kind: 'in-place' },
          },
        },
      },
    });
  }
  const configPath = join(root, 'sources.json');
  await writeFile(configPath, JSON.stringify({ version: 1, sources }));

  const server = spawn(
    process.execPath,
    [join(import.meta.dir, 'fixtures/setup-shutdown-server.ts'), root],
    {
      cwd: root,
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
  const serverAlive = (): void => {
    if (server.exitCode !== null || server.signalCode !== null) throw new Error(output);
  };
  const startedRuns = (): string[] =>
    readdirSync(markers)
      .filter(name => name.endsWith('.started'))
      .map(name => name.slice(0, -'.started'.length));
  const leaked = (runId: string): boolean => existsSync(join(markers, `${runId}.leaked`));
  let passed = false;
  try {
    await waitFor(() => {
      serverAlive();
      return existsSync(join(root, 'server.port'));
    }, 'the server to listen');
    const base = `http://127.0.0.1:${readFileSync(join(root, 'server.port'), 'utf8')}`;
    const startRun = async (source: string): Promise<string> => {
      const before = startedRuns();
      const response = await fetch(`${base}/webhooks/sources/${source}`, {
        method: 'POST',
        body: '{}',
      });
      expect(response.status).toBe(200);
      let runId: string | undefined;
      await waitFor(() => {
        serverAlive();
        runId = startedRuns().find(id => !before.includes(id));
        return runId !== undefined;
      }, `the ${source} run to start its grandchild`);
      return runId as string;
    };
    // The cancelled run starts first, so a grandchild that survived its cancel would write
    // its marker before the other run's grandchild does.
    const cancelledRun = await startRun('first');
    const otherRun = await startRun('second');

    const cancel = await fetch(`${base}/api/workflows/runs/${cancelledRun}/cancel`, {
      method: 'POST',
    });
    expect(cancel.status).toBe(200);

    await waitFor(() => leaked(otherRun), 'the other run to finish');
    expect(leaked(cancelledRun)).toBe(false);
    passed = true;
  } finally {
    server.kill('SIGKILL');
    await exited;
    // A surviving grandchild still writes into the temp tree; let it finish before removal.
    if (!passed) await Bun.sleep(GRANDCHILD_LIFETIME_MS);
  }
}, 90_000);
