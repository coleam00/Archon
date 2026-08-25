/** Environment inputs that determine the install key and Archon home. */
export const DETACHED_INSTALL_CONTEXT_KEYS = [
  'TOKEN_ENCRYPTION_KEY',
  'ARCHON_HOME',
  'ARCHON_DOCKER',
  'WORKSPACE_PATH',
  'HOME',
] as const;

export type DetachedInstallContextKey = (typeof DETACHED_INSTALL_CONTEXT_KEYS)[number];
export type DetachedInstallContext = Record<DetachedInstallContextKey, string>;

/** Capture presence and absence before a detached child changes cwd or loads env files. */
export function captureDetachedInstallContext(
  env: NodeJS.ProcessEnv = process.env
): DetachedInstallContext {
  return {
    TOKEN_ENCRYPTION_KEY: env.TOKEN_ENCRYPTION_KEY ?? '',
    ARCHON_HOME: env.ARCHON_HOME ?? '',
    ARCHON_DOCKER: env.ARCHON_DOCKER ?? '',
    WORKSPACE_PATH: env.WORKSPACE_PATH ?? '',
    HOME: env.HOME ?? '',
  };
}

/** Restore the semantic snapshot; empty wire sentinels become absent variables again. */
export function restoreDetachedInstallContext(
  context: DetachedInstallContext,
  env: NodeJS.ProcessEnv = process.env
): void {
  for (const key of DETACHED_INSTALL_CONTEXT_KEYS) {
    const value = context[key];
    if (value === '') Reflect.deleteProperty(env, key);
    else env[key] = value;
  }
}
