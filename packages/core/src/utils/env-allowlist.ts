/**
 * Subprocess environment allowlist
 *
 * Controls which process.env keys are passed to assistant subprocesses.
 * Using an allowlist prevents target-repo .env leakage (Bun auto-loads CWD .env).
 * Per-codebase env vars (codebase_env_vars table / .archon/config.yaml `env:`) are
 * merged on top by the workflow executor via requestOptions.env — those are unaffected.
 */

/** Canonical set of env vars assistant subprocesses legitimately need */
export const SUBPROCESS_ENV_ALLOWLIST = new Set([
  // System essentials needed by tools, git, shell operations
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'SSH_AUTH_SOCK',
  // Claude auth and config
  'CLAUDE_USE_GLOBAL_AUTH',
  'CLAUDE_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_VERTEX_REGION',
  // OpenAI-compatible auth/config used by Codex and Qwen
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  // Archon runtime config
  'ARCHON_HOME',
  'ARCHON_DOCKER',
  'IS_SANDBOX',
  'WORKSPACE_PATH',
  'LOG_LEVEL',
  // Git identity (used by git commits inside workflows)
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_SSH_COMMAND',
  // GitHub CLI (used by Claude Code tools)
  'GITHUB_TOKEN',
  'GH_TOKEN',
]);

/**
 * Build a clean subprocess env from process.env using the allowlist.
 * Call this instead of spreading process.env directly.
 *
 * The caller (buildSubprocessEnv in claude.ts) then applies auth filtering
 * on top (strip CLAUDE_CODE_OAUTH_TOKEN/CLAUDE_API_KEY when using global auth).
 * Per-query env overrides (requestOptions.env) are merged last by the caller.
 */
export function buildCleanSubprocessEnv(): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const key of SUBPROCESS_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) {
      clean[key] = process.env[key];
    }
  }
  return clean;
}
