// @archon-test-isolated
// @archon-test-windows
import { afterAll, expect, mock, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { ResourceStartRequestInspection } from '@archon/workflows/resource-start-store';

// The executor is a script run by this Bun, which writes its own pid where it starts.
let program: [string, ...string[]] = [process.execPath];
mock.module('./cli-program-arguments', () => ({ cliProgramArguments: () => program }));
const { spawnAdmitted } = await import('./spawn-admitted');
const { RUN_JOB_ESCAPE_ENV } = await import('./run-job-escape');
const { HandOffUncertainError } = await import('@archon/core/workflows/start-executor');

const track = trackTempRoots();
const archonHome = process.env.ARCHON_HOME;
afterAll(() => {
  if (archonHome === undefined) Reflect.deleteProperty(process.env, 'ARCHON_HOME');
  else process.env.ARCHON_HOME = archonHome;
});

function admittedIn(
  cwd: string,
  github: {
    userId?: string;
    isPerUserGitHubEnabled?: () => boolean;
    getUserGithubToken?: (userId: string) => Promise<string | undefined>;
  } = {}
) {
  const { userId, ...githubDeps } = github;
  const request: ResourceStartRequestInspection = {
    id: 'request',
    resource: 'build',
    hostId: 'host',
    overlap: 'queue',
    status: 'admitted',
    runStatus: 'pending',
    blocker: null,
    blockerRunStatus: null,
    launch: {
      version: 2,
      run: {
        id: 'request',
        workflow_name: 'deliver',
        codebase_id: 'c',
        user_message: '',
        metadata: {},
        ...(userId ? { origin: { userId } } : {}),
      },
      execution: { cwd, conversationId: 'conversation', isolation: { kind: 'in-place' } },
    },
  };
  return { deps: { store: { getResourceStartRequest: async () => request }, ...githubDeps } };
}

test('the hand-off names the process it started', async () => {
  const root = track(await mkdtemp(join(tmpdir(), 'spawn-admitted-')));
  process.env.ARCHON_HOME = root;
  const script = join(root, 'executor.ts');
  await writeFile(script, "await Bun.write('executor.pid', String(process.pid));\n");
  program = [process.execPath, script];

  const executor = await spawnAdmitted(admittedIn(root), 'request', 'host');

  let written = '';
  for (let attempt = 0; attempt < 200 && written === ''; attempt++) {
    written = await readFile(join(root, 'executor.pid'), 'utf8').catch(() => '');
    if (written === '') await Bun.sleep(25);
  }
  expect(executor).toEqual({ pid: Number(written) });
});

interface ExecutorIdentity {
  ghToken: string;
  githubToken: string;
  helpers: string;
  handoff: string;
  /** What App-mode startup made of the executor's env: 'app', or its error. */
  bootstrap: string;
}

/** The GitHub identity the executor started with, and whether App-mode startup accepts it. */
async function executorIdentity(
  root: string,
  host: ReturnType<typeof admittedIn>
): Promise<ExecutorIdentity> {
  const script = join(root, 'executor.ts');
  const config = join(import.meta.dir, '..', '..', '..', 'core', 'src', 'github-auth', 'config.ts');
  await writeFile(
    script,
    `const { loadGitHubAppConfig } = await import(${JSON.stringify(config)});
let bootstrap = 'app';
try { if (!loadGitHubAppConfig(process.env)) bootstrap = 'none'; } catch (error) { bootstrap = String(error); }
const env = process.env;
await Bun.write('identity.json', JSON.stringify({ ghToken: env.GH_TOKEN ?? '', githubToken: env.GITHUB_TOKEN ?? '',
  helpers: env.GIT_CONFIG_PARAMETERS ?? '', handoff: env.ARCHON_RUN_GITHUB_IDENTITY ?? '', bootstrap }));
`
  );
  program = [process.execPath, script];
  await spawnAdmitted(host, 'request', 'host');
  let written = '';
  for (let attempt = 0; attempt < 400 && written === ''; attempt++) {
    written = await readFile(join(root, 'identity.json'), 'utf8').catch(() => '');
    if (written === '') await Bun.sleep(25);
  }
  return JSON.parse(written) as ExecutorIdentity;
}

test("the executor carries the run's user's GitHub identity, not the spawner's, and starts in App mode", async () => {
  const keys = [
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GIT_CONFIG_PARAMETERS',
    'GITHUB_APP_ID',
    'GITHUB_APP_PRIVATE_KEY',
    'WEBHOOK_SECRET',
  ] as const;
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    // Per-user GitHub runs on an App install: the executor starts with App credentials.
    process.env.GITHUB_APP_ID = '123';
    process.env.GITHUB_APP_PRIVATE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs1', format: 'pem' })
      .toString();
    process.env.WEBHOOK_SECRET = 'secret';
    const perUser = {
      isPerUserGitHubEnabled: () => true,
      getUserGithubToken: async (userId: string) =>
        userId === 'connected' ? 'ghu_runas' : undefined,
    };

    // Spawned from a scrubbed node: the run's connected user gets their token and git helper.
    process.env.GH_TOKEN = '';
    process.env.GITHUB_TOKEN = '';
    process.env.GIT_CONFIG_PARAMETERS = "'credential.helper='";
    const root = track(await mkdtemp(join(tmpdir(), 'spawn-admitted-')));
    process.env.ARCHON_HOME = root;
    const connected = await executorIdentity(
      root,
      admittedIn(root, { userId: 'connected', ...perUser })
    );
    expect(connected).toMatchObject({ ghToken: 'ghu_runas', githubToken: '', handoff: '1' });
    expect(connected.helpers).toContain("'credential.https://github.com.helper='");
    expect(connected.bootstrap).toBe('app');

    // Spawned from a node that holds its own user's token: an unconnected run-as user is
    // scrubbed, not lent it.
    process.env.GH_TOKEN = 'ghu_caller';
    process.env.GITHUB_TOKEN = 'ghu_caller';
    const other = track(await mkdtemp(join(tmpdir(), 'spawn-admitted-')));
    process.env.ARCHON_HOME = other;
    const unconnected = await executorIdentity(
      other,
      admittedIn(other, { userId: 'unconnected', ...perUser })
    );
    expect(unconnected).toMatchObject({ ghToken: '', githubToken: '', bootstrap: 'app' });
    expect(unconnected.helpers).toEndWith("'credential.helper='");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
}, 30_000);

test('a hand-off that cannot start its process rejects', async () => {
  const root = track(await mkdtemp(join(tmpdir(), 'spawn-admitted-')));
  process.env.ARCHON_HOME = root;
  program = [join(root, 'missing-executable')];

  await expect(spawnAdmitted(admittedIn(root), 'request', 'host')).rejects.toThrow();
});

test('a hand-off whose broker relay fails is uncertain, not a failure', async () => {
  const root = track(await mkdtemp(join(tmpdir(), 'spawn-admitted-')));
  process.env.ARCHON_HOME = root;
  // Inside a Windows run the executor starts through the run's broker; this one is gone.
  process.env[RUN_JOB_ESCAPE_ENV] = join(root, 'no-broker.sock');
  try {
    await expect(spawnAdmitted(admittedIn(root), 'request', 'host')).rejects.toBeInstanceOf(
      HandOffUncertainError
    );
  } finally {
    Reflect.deleteProperty(process.env, RUN_JOB_ESCAPE_ENV);
  }
});

/** Hand the executor to a broker at a socket under `root` that answers its invocation with `answer`. */
async function withBroker(
  root: string,
  answer: (socket: Socket) => void,
  body: () => Promise<void>
): Promise<void> {
  const pipe =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\spawn-admitted-${crypto.randomUUID()}`
      : join(root, 'broker.sock');
  const server = createServer(socket => {
    socket.setEncoding('utf8');
    let received = '';
    socket.on('data', (chunk: string) => {
      received += chunk;
      if (received.includes('\n')) answer(socket);
    });
  });
  await new Promise<void>(resolveListen => server.listen(pipe, resolveListen));
  process.env[RUN_JOB_ESCAPE_ENV] = pipe;
  try {
    await body();
  } finally {
    Reflect.deleteProperty(process.env, RUN_JOB_ESCAPE_ENV);
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  }
}

test('a hand-off the broker refused before spawn is a failure, not uncertain', async () => {
  const root = track(await mkdtemp(join(tmpdir(), 'spawn-admitted-')));
  process.env.ARCHON_HOME = root;
  await withBroker(
    root,
    socket => socket.end('{"error":"EACCES: permission denied, open"}\n'),
    async () => {
      const handOff = spawnAdmitted(admittedIn(root), 'request', 'host');
      await expect(handOff).rejects.toThrow('EACCES');
      await expect(handOff).rejects.not.toBeInstanceOf(HandOffUncertainError);
    }
  );
});

test('a hand-off whose broker drops the connection mid-relay is uncertain', async () => {
  const root = track(await mkdtemp(join(tmpdir(), 'spawn-admitted-')));
  process.env.ARCHON_HOME = root;
  await withBroker(
    root,
    socket => socket.destroy(),
    async () => {
      await expect(spawnAdmitted(admittedIn(root), 'request', 'host')).rejects.toBeInstanceOf(
        HandOffUncertainError
      );
    }
  );
});
