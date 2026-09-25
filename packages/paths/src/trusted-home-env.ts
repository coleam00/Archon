/**
 * Carries the trusted Archon home into every process an Archon process spawns.
 *
 * A child inherits its parent's ARCHON_HOME after the repository env changed it, so
 * without this the child would pin a repository-chosen home as its own trusted one.
 * `loadArchonEnv` reads it before any env file loads and rewrites it after the
 * repository load, so neither env file can set it. `stripCwdEnv` refuses a cwd `.env`
 * that names it, because stripping would drop a value the parent handed over.
 *
 * The value records the ARCHON_HOME it was issued for. A child honors it only while its
 * inherited ARCHON_HOME is still that value, so a caller that deliberately points a
 * nested `archon` at another home (a test harness with a scratch home, an operator
 * script) gets that home's plugins rather than an ancestor's.
 *
 * Its own module because `strip-cwd-env` must not import `env-loader`, whose path
 * helpers initialize the logger before the cwd env is stripped.
 */
export const TRUSTED_ARCHON_HOME_ENV = 'ARCHON_TRUSTED_HOME';

interface TrustedHomeHandoff {
  /** The trusted home the child pins. */
  home: string;
  /** The ARCHON_HOME the child was spawned with, `''` when unset. */
  archonHome: string;
}

export function encodeTrustedHomeHandoff(home: string, archonHome: string): string {
  return JSON.stringify({ home, archonHome } satisfies TrustedHomeHandoff);
}

/**
 * The trusted home handed to this process, or undefined when there is no handoff or
 * ARCHON_HOME changed after it was issued. Throws on a value Archon did not write.
 */
export function readTrustedHomeHandoff(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env[TRUSTED_ARCHON_HOME_ENV];
  if (!raw) return undefined;
  let handoff: { home?: unknown; archonHome?: unknown } | null = null;
  try {
    handoff = JSON.parse(raw) as { home?: unknown; archonHome?: unknown } | null;
  } catch {
    // Reported below with every other malformed value.
  }
  if (
    typeof handoff?.home !== 'string' ||
    handoff.home === '' ||
    typeof handoff.archonHome !== 'string'
  ) {
    throw new Error(`${TRUSTED_ARCHON_HOME_ENV} is set, but not to a value Archon wrote.`);
  }
  return handoff.archonHome === (env.ARCHON_HOME ?? '') ? handoff.home : undefined;
}
