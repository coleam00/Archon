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
 * Read the setup variables. `CODEX_ID_TOKEN` marks an old Archon setup: Codex
 * does not read it, so a lone `CODEX_ACCESS_TOKEN` is the user's own Codex auth
 * and is neither read nor reported.
 *
 * - Any `ARCHON_` name: only the new names are read. Old names left beside them
 *   are reported as deprecated, because they still reach Codex.
 * - Otherwise, with `CODEX_ID_TOKEN`: the old names are read and reported.
 */
export function readCodexSetupEnv(env: Record<string, string | undefined>): CodexSetupEnv {
  const values: CodexSetupValues = {};
  const deprecated: CodexSetupEnv['deprecated'] = [];
  const hasLegacy = Boolean(env.CODEX_ID_TOKEN);
  const useLegacy = hasLegacy && !FIELDS.some(f => env[CODEX_SETUP_ENV[f].name]);
  for (const field of FIELDS) {
    const vars = CODEX_SETUP_ENV[field];
    if (hasLegacy && env[vars.legacy]) deprecated.push(vars);
    const value = env[useLegacy ? vars.legacy : vars.name];
    if (value) values[field] = value;
  }
  return { values, deprecated };
}

/**
 * Rewrite an old Archon setup in a parsed `.env` to the new names, for
 * `archon setup`. Same marker as the reader. A new name that already has a
 * value keeps it; the old line is dropped either way.
 */
export function migrateCodexSetupEnv(env: Record<string, string>): Record<string, string> {
  if (!env.CODEX_ID_TOKEN) return env;
  const legacyNames = new Set<string>(FIELDS.map(f => CODEX_SETUP_ENV[f].legacy));
  const migrated = Object.fromEntries(Object.entries(env).filter(([key]) => !legacyNames.has(key)));
  for (const field of FIELDS) {
    const vars = CODEX_SETUP_ENV[field];
    const old = env[vars.legacy];
    if (old !== undefined && !migrated[vars.name]?.trim()) migrated[vars.name] = old;
  }
  return migrated;
}

/** One warning naming every deprecated variable in use and its replacement. Names only, never values. */
export function formatCodexSetupDeprecation(deprecated: CodexSetupEnv['deprecated']): string {
  const renames = deprecated.map(v => `${v.legacy} -> ${v.name}`).join(', ');
  return (
    `Deprecated Codex setup variables in use: ${renames}. ` +
    'Codex reads CODEX_ACCESS_TOKEN itself, so the old names can override your own Codex login. ' +
    'Re-run `archon setup` to move them to the new names, or rename them in your .env and delete the old lines. ' +
    'The old names stop working in the next release.'
  );
}
