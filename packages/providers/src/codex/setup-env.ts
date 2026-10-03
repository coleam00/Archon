/**
 * Archon's own Codex setup variables.
 *
 * `archon setup` copies a Codex login into these variables, and the Docker
 * entrypoint (`setup-auth`) writes them back out as `~/.codex/auth.json`. They
 * carry an `ARCHON_` prefix because Archon passes its environment to the Codex
 * child, and Codex reads its own `CODEX_*` names (`CODEX_ACCESS_TOKEN` is an auth
 * input). An Archon value under a Codex-native name would override the user's
 * own Codex login, so Archon never sets one.
 *
 * The unprefixed names are read as a deprecated fallback for one release.
 * Remove `legacy` and the fallback in the release after that.
 */
export const CODEX_SETUP_ENV = {
  idToken: { name: 'ARCHON_CODEX_ID_TOKEN', legacy: 'CODEX_ID_TOKEN' },
  accessToken: { name: 'ARCHON_CODEX_ACCESS_TOKEN', legacy: 'CODEX_ACCESS_TOKEN' },
  refreshToken: { name: 'ARCHON_CODEX_REFRESH_TOKEN', legacy: 'CODEX_REFRESH_TOKEN' },
  accountId: { name: 'ARCHON_CODEX_ACCOUNT_ID', legacy: 'CODEX_ACCOUNT_ID' },
} as const;

type CodexSetupField = keyof typeof CODEX_SETUP_ENV;
const FIELDS = Object.keys(CODEX_SETUP_ENV) as CodexSetupField[];

export type CodexSetupValues = Partial<Record<CodexSetupField, string>>;

export interface CodexSetupEnv {
  values: CodexSetupValues;
  /** Deprecated unprefixed names the values came from. */
  deprecated: (typeof CODEX_SETUP_ENV)[CodexSetupField][];
}

/**
 * Read the setup variables. Any `ARCHON_` name selects the new names only.
 * Otherwise the old names are read as a set, and only when `CODEX_ID_TOKEN` is
 * present: a lone `CODEX_ACCESS_TOKEN` is the user's own Codex auth, not an old
 * Archon setup, and must not be reported as deprecated.
 */
export function readCodexSetupEnv(env: Record<string, string | undefined>): CodexSetupEnv {
  const values: CodexSetupValues = {};
  const deprecated: CodexSetupEnv['deprecated'] = [];
  const legacy = !FIELDS.some(f => env[CODEX_SETUP_ENV[f].name]) && Boolean(env.CODEX_ID_TOKEN);
  for (const field of FIELDS) {
    const vars = CODEX_SETUP_ENV[field];
    const value = env[legacy ? vars.legacy : vars.name];
    if (!value) continue;
    values[field] = value;
    if (legacy) deprecated.push(vars);
  }
  return { values, deprecated };
}

/** One warning naming every deprecated variable in use and its replacement. Names only, never values. */
export function formatCodexSetupDeprecation(deprecated: CodexSetupEnv['deprecated']): string {
  const renames = deprecated.map(v => `${v.legacy} -> ${v.name}`).join(', ');
  return (
    `Deprecated Codex setup variables in use: ${renames}. ` +
    'Codex reads CODEX_ACCESS_TOKEN itself, so the old names can override your own Codex login. ' +
    'Rename them in your .env; the old names stop working in the next release.'
  );
}
