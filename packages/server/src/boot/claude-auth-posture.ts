/**
 * Boot-time Claude auth-posture decisions, extracted as pure env→bool functions
 * so they're testable in isolation (no bootstrap soup) and so the rationale
 * lives in one place rather than inline in `index.ts`.
 *
 * Background: `CLAUDE_USE_GLOBAL_AUTH` is an Archon-only boot sentinel — the
 * Claude Code CLI never reads it. Its only runtime effect is satisfying the
 * boot credential check. Per-user installs (`TOKEN_ENCRYPTION_KEY` set) deliver
 * Claude auth PER REQUEST from the encrypted store, so forcing the global-auth
 * sentinel there is both unnecessary and actively misleading during triage
 * (it made the Claude provider log `using_global_auth` on installs that were
 * actually authenticating fine — see #1983). These helpers keep the sentinel
 * to solo installs that truly rely on a shared `claude /login`.
 */

/**
 * Whether the server should auto-set `CLAUDE_USE_GLOBAL_AUTH=true` at boot.
 * Only for solo installs with no explicit install-level Claude credentials AND
 * no per-user provider keys — and never when the operator has set the var
 * explicitly (either value is an explicit choice we must not override).
 */
export function shouldDefaultClaudeGlobalAuth(env: NodeJS.ProcessEnv): boolean {
  if (env.CLAUDE_USE_GLOBAL_AUTH !== undefined) return false; // operator chose explicitly
  // Using truthiness intentionally: an empty string is a missing credential.
  if (env.CLAUDE_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN) return false; // explicit install creds
  if (env.TOKEN_ENCRYPTION_KEY) return false; // per-user keys → auth is per-request
  return true;
}

/**
 * Whether the install has SOME valid Claude auth posture for the boot
 * credential check, so the server doesn't `exit(1)` on a legitimately
 * per-user-only install (no shared Claude key, auth delivered per request).
 */
export function hasClaudeBootAuthPosture(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.CLAUDE_API_KEY ||
    env.CLAUDE_CODE_OAUTH_TOKEN ||
    // Enabled-only: `CLAUDE_USE_GLOBAL_AUTH=false` is an explicit opt-out (setup.ts
    // writes it), so plain truthiness would wrongly count it as a valid posture.
    env.CLAUDE_USE_GLOBAL_AUTH === 'true' ||
    env.TOKEN_ENCRYPTION_KEY // per-user keys deliver Claude auth per request
  );
}
