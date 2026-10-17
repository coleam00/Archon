import {
  CODEX_SETUP_ENV,
  readCodexSetupEnv,
  type CodexSetupEnv,
} from '@archon/providers/codex/setup-env';

/** The setup variables the boot check requires, named in its log fields and hint. */
export const CODEX_BOOT_CHECKED = [CODEX_SETUP_ENV.idToken.name, CODEX_SETUP_ENV.accessToken.name];

/**
 * Whether the install has Codex setup credentials for the boot credential
 * check, read through the same names and deprecated fallback as `setup-auth`.
 */
export function readCodexBootAuth(env: NodeJS.ProcessEnv): {
  hasCredentials: boolean;
  deprecated: CodexSetupEnv['deprecated'];
} {
  const { values, deprecated } = readCodexSetupEnv(env);
  return { hasCredentials: Boolean(values.idToken && values.accessToken), deprecated };
}
