/**
 * Doctor command - Verifies the local Archon setup.
 *
 * Also invoked from the end of `archon setup`; the setup wizard discards the
 * return value so a doctor failure does not abort setup (the env file was
 * already written successfully).
 */
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { execFileAsync } from '@archon/git';
import { BUNDLED_IS_BINARY, getArchonHome, createLogger } from '@archon/paths';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('cli.doctor');
  return cachedLog;
}

export interface CheckResult {
  label: string;
  status: 'pass' | 'fail' | 'skip';
  message: string;
}

export async function checkClaudeBinary(
  env: NodeJS.ProcessEnv,
  // Injected so tests can drive the binary-mode branch — `BUNDLED_IS_BINARY`
  // is a static const re-export and cannot be spied at runtime.
  isBinary: boolean = BUNDLED_IS_BINARY
): Promise<CheckResult> {
  const label = 'Claude binary';
  if (!isBinary) {
    return { label, status: 'skip', message: 'dev mode (SDK resolves via node_modules)' };
  }
  const path = env.CLAUDE_BIN_PATH;
  if (!path) {
    return {
      label,
      status: 'fail',
      message: 'CLAUDE_BIN_PATH is not set. Run `archon setup` to configure.',
    };
  }
  try {
    await execFileAsync(path, ['--version'], { timeout: 5000 });
    return { label, status: 'pass', message: `${path} (spawns OK)` };
  } catch (err) {
    return {
      label,
      status: 'fail',
      message: `${path} did not spawn: ${(err as Error).message}`,
    };
  }
}

export async function checkGhAuth(env: NodeJS.ProcessEnv): Promise<CheckResult> {
  const label = 'gh CLI';
  // Skip for users without GitHub configured — gh auth is irrelevant
  // to a CLI-only or Slack/Telegram setup, so reporting fail would be noise.
  if (!env.GITHUB_TOKEN && !env.GH_TOKEN) {
    return { label, status: 'skip', message: 'GitHub not configured (no GITHUB_TOKEN)' };
  }
  try {
    await execFileAsync('gh', ['auth', 'status'], { timeout: 10_000 });
    return { label, status: 'pass', message: 'authenticated' };
  } catch (err) {
    return {
      label,
      status: 'fail',
      message: `gh auth status failed: ${(err as Error).message}. Run \`gh auth login\`.`,
    };
  }
}

export interface DatabaseDeps {
  pool: { query: (sql: string) => Promise<unknown> };
  getDatabaseType: () => string;
}

export async function checkDatabase(
  // Injected so tests can drive both code paths without mocking the dynamic
  // import. Falls back to the lazy `@archon/core` import in production.
  loadDeps: () => Promise<DatabaseDeps> = defaultLoadDatabaseDeps
): Promise<CheckResult> {
  const label = 'Database';
  let deps: DatabaseDeps;
  try {
    deps = await loadDeps();
  } catch (err) {
    // Distinguish module-load failure from query failure — surfacing
    // "not reachable" for an import error misleads the user into running
    // `archon setup` when the real fix is a binary rebuild.
    getLog().error({ err }, 'doctor.db_module_load_failed');
    return {
      label,
      status: 'fail',
      message: `failed to load database module: ${(err as Error).message}`,
    };
  }
  try {
    const dbType = deps.getDatabaseType();
    await deps.pool.query('SELECT 1');
    return { label, status: 'pass', message: `reachable (${dbType})` };
  } catch (err) {
    getLog().error({ err }, 'doctor.db_query_failed');
    return { label, status: 'fail', message: `not reachable: ${(err as Error).message}` };
  }
}

async function defaultLoadDatabaseDeps(): Promise<DatabaseDeps> {
  // Lazy import so doctor doesn't pull in the full @archon/core graph just to
  // print --help or run a different check.
  const { pool, getDatabaseType } = await import('@archon/core');
  return { pool, getDatabaseType };
}

export async function checkWorkspaceWritable(): Promise<CheckResult> {
  const label = 'Workspace';
  const home = getArchonHome();
  const probe = join(home, `.doctor-probe-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(probe, 'ok');
  } catch (err) {
    return { label, status: 'fail', message: `${home} not writable: ${(err as Error).message}` };
  }
  try {
    rmSync(probe, { force: true });
  } catch (err) {
    // Deletion failure is cosmetic — the write succeeded, so the dir is
    // writable. Log so repeated failures leave a diagnostic trace instead of
    // silently accumulating .doctor-probe-* files in ARCHON_HOME.
    getLog().warn({ probe, err }, 'doctor.workspace_probe_delete_failed');
  }
  return { label, status: 'pass', message: `${home} is writable` };
}

export async function checkBundledDefaults(): Promise<CheckResult> {
  const label = 'Bundled defaults';
  try {
    const { BUNDLED_COMMANDS, BUNDLED_WORKFLOWS } = await import('@archon/workflows/defaults');
    const commands = Object.keys(BUNDLED_COMMANDS).length;
    const workflows = Object.keys(BUNDLED_WORKFLOWS).length;
    return {
      label,
      status: 'pass',
      message: `${workflows} workflow(s), ${commands} command(s) loaded`,
    };
  } catch (err) {
    return { label, status: 'fail', message: `failed to load: ${(err as Error).message}` };
  }
}

export async function checkSlack(env: NodeJS.ProcessEnv): Promise<CheckResult> {
  const label = 'Slack';
  const token = env.SLACK_BOT_TOKEN;
  if (!token) {
    return { label, status: 'skip', message: 'no SLACK_BOT_TOKEN set' };
  }
  try {
    const res = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    const body = (await res.json()) as { ok?: boolean; error?: string };
    if (body.ok) {
      return { label, status: 'pass', message: 'auth.test OK' };
    }
    return { label, status: 'fail', message: `auth.test rejected: ${body.error ?? 'unknown'}` };
  } catch (err) {
    // Network errors → skip, not fail — best-effort by design.
    return {
      label,
      status: 'skip',
      message: `ping skipped (${(err as Error).message})`,
    };
  }
}

export async function checkTelegram(env: NodeJS.ProcessEnv): Promise<CheckResult> {
  const label = 'Telegram';
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return { label, status: 'skip', message: 'no TELEGRAM_BOT_TOKEN set' };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(5000),
    });
    const body = (await res.json()) as { ok?: boolean; description?: string };
    if (body.ok) {
      return { label, status: 'pass', message: 'getMe OK' };
    }
    return {
      label,
      status: 'fail',
      message: `getMe rejected: ${body.description ?? 'unknown'}`,
    };
  } catch (err) {
    return {
      label,
      status: 'skip',
      message: `ping skipped (${(err as Error).message})`,
    };
  }
}

function renderResult(r: CheckResult): string {
  const icon = r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : '○';
  return `${icon} ${r.label}: ${r.message}`;
}

export async function doctorCommand(
  // Injected so tests can drive the exit-code contract and the
  // Promise.allSettled rejection branch with synthetic checks.
  checks?: (() => Promise<CheckResult>)[]
): Promise<number> {
  console.log('archon doctor — verifying your setup\n');
  getLog().info('doctor.run_started');
  const env = process.env;

  const promises = checks
    ? checks.map(fn => fn())
    : [
        checkClaudeBinary(env),
        checkGhAuth(env),
        checkDatabase(),
        checkWorkspaceWritable(),
        checkBundledDefaults(),
        checkSlack(env),
        checkTelegram(env),
      ];

  // Promise.allSettled so one unexpected rejection doesn't skip remaining checks.
  const settled = await Promise.allSettled(promises);

  let failures = 0;
  for (const s of settled) {
    if (s.status === 'rejected') {
      failures++;
      const msg = s.reason instanceof Error ? s.reason.message : String(s.reason);
      console.log(`✗ unknown: check threw: ${msg}`);
      getLog().error({ reason: s.reason }, 'doctor.check_threw_unexpectedly');
      continue;
    }
    if (s.value.status === 'fail') failures++;
    console.log(renderResult(s.value));
  }

  console.log('');
  if (failures === 0) {
    console.log('All checks passed.');
    getLog().info('doctor.run_completed');
    return 0;
  }
  console.log(`${failures} check(s) failed. Run \`archon setup\` to reconfigure.`);
  getLog().warn({ failures }, 'doctor.run_failed');
  return 1;
}
