import { randomUUID } from 'node:crypto';
import { execFileAsync } from './exec';

export async function resolvePushDestinations(repoPath: string, remote: string): Promise<string[]> {
  const { stdout: config } = await execFileAsync(
    'git',
    ['-C', repoPath, 'config', '--null', '--list'],
    { timeout: 10000 }
  );
  for (const record of config.split('\0')) {
    const separator = record.indexOf('\n');
    const key = record.slice(0, separator);
    // get-url has no NUL output mode. Reject ambiguous URL values before splitting its output.
    // Git rejects newlines in config keys, so rewrite destinations cannot introduce them.
    if (
      (key === `remote.${remote}.url` || key === `remote.${remote}.pushurl`) &&
      record.indexOf('\n', separator + 1) !== -1
    ) {
      throw new Error('Newlines in push destination configuration are unsupported');
    }
  }
  const { stdout } = await execFileAsync(
    'git',
    ['-C', repoPath, 'remote', 'get-url', '--push', '--all', remote],
    { timeout: 10000 }
  );
  const destinations = stdout.split('\n').filter(destination => destination !== '');
  if (!destinations.length) throw new Error('No push destination');
  return destinations;
}

/** Pin Git's single URL rewrite to an already resolved endpoint for reads and pushes. */
export function pinGitDestination(destination: string): {
  endpoint: string;
  env: NodeJS.ProcessEnv;
} {
  const endpoint = `archon-cleanup-${randomUUID()}:`;
  const env = { ...process.env };
  const count = Number(env.GIT_CONFIG_COUNT ?? '0');
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid GIT_CONFIG_COUNT');
  for (const [offset, setting] of ['insteadOf', 'pushInsteadOf'].entries()) {
    env[`GIT_CONFIG_KEY_${String(count + offset)}`] = `url.${destination}.${setting}`;
    env[`GIT_CONFIG_VALUE_${String(count + offset)}`] = endpoint;
  }
  env.GIT_CONFIG_COUNT = String(count + 2);
  return { endpoint, env };
}
