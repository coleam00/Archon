import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { serverReleaseAsset } from '@archon/paths/server-launch';
import packageJson from '../package.json';

const [cliFile, serverFile, webTarball, versionArg] = Bun.argv.slice(2);
const version = versionArg ?? packageJson.version;
if (!cliFile || !serverFile || !webTarball) {
  throw new Error('Usage: smoke-serve.ts <cli> <server> <web-tarball> [version]');
}
const root = mkdtempSync(join(tmpdir(), 'archon-serve-smoke-'));
const stdoutPath = join(root, 'stdout.log');
const stderrPath = join(root, 'stderr.log');
let serverPid: number | undefined;
let child: Bun.Subprocess<'ignore', Bun.BunFile, Bun.BunFile> | undefined;
function stopServer(signal: NodeJS.Signals): void {
  if (serverPid === undefined) return;
  try {
    process.kill(serverPid, signal);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}
try {
  const home = join(root, 'home');
  const webDir = join(home, 'web-dist', version);
  const serverDir = join(home, 'server', version);
  const asset = serverReleaseAsset(
    `bun-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`
  );
  mkdirSync(webDir, { recursive: true });
  mkdirSync(serverDir, { recursive: true });
  copyFileSync(resolve(serverFile), join(serverDir, asset));
  chmodSync(join(serverDir, asset), 0o755);
  const cli = resolve(cliFile);
  chmodSync(cli, 0o755);
  // Git's tar cannot handle Windows drive letters; use the system bsdtar.
  const tar =
    process.platform === 'win32'
      ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
  const extracted = Bun.spawnSync([tar, 'xzf', '-', '-C', webDir, '--strip-components=1'], {
    stdin: Bun.file(resolve(webTarball)),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (extracted.exitCode !== 0) throw new Error(extracted.stderr.toString());
  const port = 43090;
  child = Bun.spawn([cli, 'serve', '--port', String(port)], {
    cwd: root,
    env: {
      ...process.env,
      ARCHON_HOME: home,
      DATABASE_URL: '',
      WEB_AUTH_ENABLED: 'false',
      PORT: '',
      LOG_LEVEL: 'info',
      CLAUDE_USE_GLOBAL_AUTH: 'true',
      ARCHON_TELEMETRY_DISABLED: '1',
    },
    stdin: 'ignore',
    stdout: Bun.file(stdoutPath),
    stderr: Bun.file(stderrPath),
  });
  let ready = false;
  let serverReady = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(`serve exited early: ${child.exitCode}`);
    for (const line of readFileSync(stdoutPath, 'utf8').split('\n')) {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      } // Non-JSON startup output remains in the diagnostic log.
      if (typeof event !== 'object' || event === null || !('msg' in event)) continue;
      if (
        event.msg === 'server.spawned' &&
        'serverPid' in event &&
        typeof event.serverPid === 'number'
      )
        serverPid = event.serverPid;
      if (event.msg === 'server_ready') serverReady = true;
    }
    try {
      const health = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (health.ok && serverReady) {
        ready = true;
        break;
      }
    } catch {
      /* Startup has not bound the port yet. */
    }
    await Bun.sleep(250);
  }
  if (!ready || serverPid === undefined)
    throw new Error('serve did not become ready within 30 seconds');
  const consoleResponse = await fetch(`http://127.0.0.1:${port}/`, {
    signal: AbortSignal.timeout(1000),
  });
  if (!consoleResponse.ok || !(await consoleResponse.text()).includes('<!doctype html>'))
    throw new Error('serve did not serve the console');
  console.log(
    `serve smoke passed for Archon ${version}: health and console, server PID ${serverPid}`
  );
} finally {
  if (child) {
    // Windows process termination does not deliver POSIX SIGTERM to a parent
    // handler. Stop the recorded server PID directly on that host.
    if (process.platform === 'win32') stopServer('SIGTERM');
    child.kill('SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        child.exited,
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, 10_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (child.exitCode === null) {
      stopServer('SIGKILL');
      child.kill('SIGKILL');
    }
    await child.exited;
    console.log(readFileSync(stdoutPath, 'utf8'));
    console.error(readFileSync(stderrPath, 'utf8'));
  }
  await removeTempTree(root);
}
