import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
  for (const name of names) {
    const token = credentialEnv[name];
    if (token) return { kind: 'selected', token, source: name };
  }
  // Empty values are also the engine's per-user credential scrub. Never borrow
  // the host login when a run was explicitly denied a credential.
  if (names.some(name => credentialEnv[name] !== undefined)) {
    return { kind: 'missing', message: `credential environment ${names.join(' or ')} is empty` };
  }
  if (github) {
    try {
      const { stdout } = await execFileAsync('gh', ['auth', 'token', '--hostname', host], {
        env: {
          ...hostEnv,
          PATH: hostEnv.PATH ?? '',
          GH_TOKEN: '',
          GITHUB_TOKEN: '',
          GH_ENTERPRISE_TOKEN: '',
          GITHUB_ENTERPRISE_TOKEN: '',
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
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
        return {
          kind: 'failed',
          message: `gh auth token --hostname ${host} failed; repair the gh login`,
        };
      }
    }
  }
  if (names.length === 0) return { kind: 'none' };
  return {
    kind: 'missing',
    message: `credential environment ${names.join(' or ')} is not set${github ? '; gh is not installed' : ''}`,
  };
}
