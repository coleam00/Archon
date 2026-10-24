import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GH_DOTCOM_TOKEN_KEYS, GH_ENTERPRISE_TOKEN_KEYS } from '@archon/paths/github-token-env';

const execFileAsync = promisify(execFile);

type ResolvedForgeCredential =
  | { kind: 'selected'; token: string; source: string }
  | { kind: 'none' }
  | { kind: 'missing' | 'failed'; message: string };

export async function selectCredential(
  names: readonly string[],
  github: boolean,
  host: string,
  credentialEnv: NodeJS.ProcessEnv,
  hostEnv: NodeJS.ProcessEnv
): Promise<ResolvedForgeCredential> {
  // The App-owned PATH shim refreshes installation tokens per operation. Preserve
  // its dispatch token so the shim recognizes App mode; personal tokens bypass it.
  const refreshApp =
    github &&
    host === 'github.com' &&
    Boolean(credentialEnv.ARCHON_GITHUB_APP_REPO && credentialEnv.ARCHON_PORT) &&
    credentialEnv.GH_TOKEN?.startsWith('ghs_') === true;
  for (const name of names) {
    const token = credentialEnv[name];
    if (token && !refreshApp) return { kind: 'selected', token, source: name };
  }
  // Empty values are also the engine's per-user credential scrub. Never borrow
  // the host login when a run was explicitly denied a credential.
  if (!refreshApp && names.some(name => credentialEnv[name] !== undefined)) {
    return { kind: 'missing', message: `credential environment ${names.join(' or ')} is empty` };
  }
  if (github) {
    const credential = await readGhCredential(host, credentialEnv, hostEnv, refreshApp);
    if (credential) return credential;
  }
  if (names.length === 0) return { kind: 'none' };
  return {
    kind: 'missing',
    message: `credential environment ${names.join(' or ')} is not set${github ? '; gh is not installed' : ''}`,
  };
}

async function readGhCredential(
  host: string,
  credentialEnv: NodeJS.ProcessEnv,
  hostEnv: NodeJS.ProcessEnv,
  refreshApp: boolean
): Promise<ResolvedForgeCredential | undefined> {
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token', '--hostname', host], {
      env: {
        ...hostEnv,
        PATH: hostEnv.PATH ?? '',
        ...Object.fromEntries(GH_ENTERPRISE_TOKEN_KEYS.map(key => [key, ''])),
        ...Object.fromEntries(
          GH_DOTCOM_TOKEN_KEYS.map(key => [key, refreshApp ? credentialEnv[key] : ''])
        ),
      },
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
      windowsHide: true,
    });
    const token = stdout.trim();
    return token
      ? { kind: 'selected', token, source: 'gh auth token' }
      : { kind: 'failed', message: `gh auth token --hostname ${host} returned an empty token` };
  } catch (error) {
    // gh's stdout, stderr and error message may contain credentials.
    if (refreshApp || !(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      return {
        kind: 'failed',
        message: `gh auth token --hostname ${host} failed; repair the gh login`,
      };
    }
  }
  return undefined;
}
