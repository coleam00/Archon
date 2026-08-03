/**
 * `archon auth github` — connect the current CLI user's GitHub identity via the
 * device flow. Only meaningful when per-user GitHub is enabled (GitHub App +
 * TOKEN_ENCRYPTION_KEY); solo `GITHUB_TOKEN` installs don't need it.
 *
 * CLI identity: ARCHON_USER_ID (explicit override) else $USER/$USERNAME. We
 * resolve it to a stable Archon user via the 'cli' platform identity so the
 * connected GitHub token attaches to the same user across CLI invocations.
 */
import { createLogger } from '@archon/paths';
import {
  isPerUserGitHubEnabled,
  connectGithubForUser,
  DeviceFlowError,
  GithubIdentityConflictError,
} from '@archon/core';
import * as userDb from '@archon/core/db/users';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('cli.auth');
  return cachedLog;
}

export function resolveCliUserId(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.ARCHON_USER_ID?.trim();
  if (explicit) return explicit;
  const sys = env.USER?.trim() || env.USERNAME?.trim();
  return sys || null;
}

export async function authGithubCommand(): Promise<number> {
  if (!isPerUserGitHubEnabled()) {
    console.error(
      'Per-user GitHub auth is not enabled on this install.\n' +
        'It requires the GitHub App (GITHUB_APP_ID + GITHUB_APP_CLIENT_ID) and TOKEN_ENCRYPTION_KEY.\n' +
        'Solo installs using GITHUB_TOKEN do not need to connect.'
    );
    return 1;
  }

  const cliId = resolveCliUserId();
  if (!cliId) {
    console.error('Could not determine your CLI identity. Set ARCHON_USER_ID (or $USER).');
    return 1;
  }

  const user = await userDb.findOrCreateUserByPlatformIdentity('cli', cliId, cliId);
  console.log(`Opening device flow for user_id: ${cliId}`);

  try {
    const result = await connectGithubForUser(user.id, info => {
      console.log(`\n→ Visit ${info.verification_uri} and enter code: ${info.user_code}`);
      console.log('→ Waiting for authorization…');
    });
    console.log(`\n✓ Connected as @${result.githubLogin}. Tokens stored encrypted in Archon's DB.`);
    return 0;
  } catch (err) {
    if (err instanceof GithubIdentityConflictError) {
      console.error(`\n✗ ${err.message}`);
    } else if (err instanceof DeviceFlowError) {
      console.error(`\n✗ Device flow failed (${err.code}): ${err.message}`);
    } else {
      getLog().error({ err: err as Error }, 'cli.auth_github_failed');
      console.error(`\n✗ Connect failed: ${(err as Error).message}`);
    }
    return 1;
  }
}
