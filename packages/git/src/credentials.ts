import type { CloneCredentials } from './repo';

const ENV_CREDENTIAL_HELPER =
  '!f() { test "$1" = get || exit 0; printf \'%s\\n\' "username=$ARCHON_GIT_USERNAME" "password=$ARCHON_GIT_PASSWORD"; }; f';

export function gitCredentialOptions(
  httpUrl: URL | null,
  credentials?: CloneCredentials
): { args: string[]; env: NodeJS.ProcessEnv } {
  if (credentials && !httpUrl)
    throw new Error('Authenticated git requests require an HTTP(S) repository URL');
  const args: string[] = [];
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  delete env.ARCHON_GIT_USERNAME;
  delete env.ARCHON_GIT_PASSWORD;
  if (credentials && httpUrl) {
    args.push(
      '-c',
      'credential.helper=',
      '-c',
      `credential.${httpUrl.origin}.helper=${ENV_CREDENTIAL_HELPER}`
    );
    env.ARCHON_GIT_USERNAME = credentials.username;
    env.ARCHON_GIT_PASSWORD = credentials.password;
  }
  return { args, env };
}

export function sanitizeGitError(error: unknown, credentials?: CloneCredentials): string {
  const err = error as Error & { stdout?: string; stderr?: string };
  let message = [err.message, err.stderr, err.stdout].filter(Boolean).join('\n');
  const credentialValues = credentials
    ? [credentials.username, credentials.password]
        .filter(value => value.length > 0)
        .sort((left, right) => right.length - left.length)
    : [];
  for (const value of credentialValues) message = message.replaceAll(value, '***');
  return message;
}
