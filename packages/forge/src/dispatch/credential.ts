import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pluginEnvironment } from './exec';
const run = promisify(execFile);
type ReadCredential = (host: string, env: NodeJS.ProcessEnv) => Promise<string>;
const readCredential: ReadCredential = async (host, env) => {
  const result = await run('gh', ['auth', 'token', '--hostname', host], {
    env,
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
  return result.stdout;
};
/** CLI host only: service hosts must supply their selected user's credential explicitly. */
export async function nativeGitHubCredential(
  env: NodeJS.ProcessEnv,
  host: string,
  read: ReadCredential = readCredential
): Promise<string | undefined> {
  if (host !== 'github.com') return undefined;
  // Re-entry belongs to the workflow host's selected credential environment.
  // Startup can remove scrubbed token keys that also appear in the cwd .env.
  if (env.ARCHON_EXECUTABLE) return undefined;
  if (env.GH_TOKEN === '' && env.GITHUB_TOKEN === '') return undefined;
  const credentialEnv = pluginEnvironment(env);
  // gh owns the config and keyring. Preserve the invoking user's config location,
  // never copy credentials from files or expose the helper's output/diagnostics.
  for (const key of [
    'GH_CONFIG_DIR',
    'XDG_CONFIG_HOME',
    'APPDATA',
    'LOCALAPPDATA',
    'DBUS_SESSION_BUS_ADDRESS',
    'XDG_RUNTIME_DIR',
  ]) {
    if (env[key] !== undefined) credentialEnv[key] = env[key];
  }
  try {
    return (await read(host, credentialEnv)).trim() || undefined;
  } catch {
    // Missing CLI or unavailable native credential is the normal no_credential boundary.
    return undefined;
  }
}
