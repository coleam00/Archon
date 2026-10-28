import type { CredentialStatus, StoredCredentialKind } from '@archon/provider-contract';
import type { CheckResult } from './doctor-check';

export interface ProviderDeps {
  listUserProviderKeys: (
    userId: string
  ) => Promise<{ provider: string; kind: StoredCredentialKind; label: string | null }[]>;
  getStoredCredentialStatus: (userId: string, vendor: string) => Promise<CredentialStatus>;
  // `platform` is the literal 'cli' — this check resolves the CLI identity only,
  // and narrowing it keeps the real (platform-union-typed) db fn assignable here.
  findOrCreateUserByPlatformIdentity: (
    platform: 'cli',
    id: string,
    name: string
  ) => Promise<{ id: string }>;
}

/** One line for a connected credential: its state, and what to do when it fails. */
function describeStoredCredential(
  row: { provider: string; kind: string },
  status: CredentialStatus
): string {
  const name = `${row.provider} (${row.kind})`;
  const reconnect =
    row.kind === 'oauth' ? `archon ai login ${row.provider}` : `archon ai key set ${row.provider}`;
  switch (status.state) {
    case 'usable':
      return `${name}: usable`;
    case 'not_connected':
      return `${name}: no longer connected`;
    case 'not_checked':
      return `${name}: not checked`;
    case 'unusable':
      return `${name}: cannot be used. Reconnect: ${reconnect}. Cause: ${status.evidence}`;
    case 'check_failed':
      return `${name}: could not be verified. If it persists, reconnect: ${reconnect}. Cause: ${status.evidence}`;
  }
}

/**
 * Check every AI-provider credential the current CLI user connected, the way a run
 * would use it: decrypt, and refresh an expired OAuth grant (saving any rotation).
 * Fails when a credential cannot be used and warns when one could not be verified.
 * Skips when there is no CLI identity, nothing is connected, or the database cannot
 * be read, so a DB hiccup does not make `archon doctor` exit non-zero.
 */
export async function checkConnectedProviders(
  env: NodeJS.ProcessEnv = process.env,
  // Injected so tests can drive every branch without the dynamic @archon/core import.
  loadDeps: () => Promise<ProviderDeps> = loadProviderDeps
): Promise<CheckResult> {
  const label = 'AI credentials';
  const cliId = env.ARCHON_USER_ID || env.USER || env.USERNAME;
  if (!cliId) {
    return { label, status: 'skip', message: 'no CLI identity (set ARCHON_USER_ID or USER)' };
  }
  let deps: ProviderDeps;
  try {
    deps = await loadDeps();
  } catch (err) {
    return {
      label,
      status: 'skip',
      message: `could not load credential module: ${(err as Error).message}`,
    };
  }
  let checked: { row: { provider: string; kind: string }; status: CredentialStatus }[];
  try {
    const user = await deps.findOrCreateUserByPlatformIdentity('cli', cliId, cliId);
    const rows = await deps.listUserProviderKeys(user.id);
    if (rows.length === 0) {
      return {
        label,
        status: 'skip',
        message: 'none connected — run: archon ai login <vendor>  or  archon ai key set <vendor>',
      };
    }
    checked = await Promise.all(
      rows.map(async row => ({
        row,
        status: await deps.getStoredCredentialStatus(user.id, row.provider),
      }))
    );
  } catch (err) {
    return {
      label,
      status: 'skip',
      message: `could not read credentials: ${(err as Error).message}`,
    };
  }
  const states = checked.map(c => c.status.state);
  const status = states.includes('unusable')
    ? 'fail'
    : states.includes('check_failed')
      ? 'warn'
      : 'pass';
  const lines = checked.map(c => `\n    ${describeStoredCredential(c.row, c.status)}`);
  return { label, status, message: `${checked.length} connected${lines.join('')}` };
}

export async function loadProviderDeps(): Promise<ProviderDeps> {
  // Lazy imports so doctor doesn't pull the full @archon/core graph for an
  // unrelated check.
  const { listUserProviderKeys, getStoredCredentialStatus } = await import('@archon/core');
  const userDb = await import('@archon/core/db/users');
  return {
    listUserProviderKeys,
    getStoredCredentialStatus,
    findOrCreateUserByPlatformIdentity: userDb.findOrCreateUserByPlatformIdentity,
  };
}
