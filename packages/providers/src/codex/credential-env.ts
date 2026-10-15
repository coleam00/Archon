/**
 * Env vars through which Archon hands Codex a credential. Core's delivery writes them;
 * the Codex provider reads them and logs the app-server in over JSON-RPC, so the
 * credential never reaches the user's CODEX_HOME. Distinct from `CODEX_SETUP_ENV`
 * (./setup-env), which seeds `~/.codex/auth.json` at install time: sharing those names
 * would log every turn into the install-wide account.
 */
export const CODEX_CREDENTIAL_ENV = {
  apiKey: 'CODEX_API_KEY',
  chatgptAccessToken: 'ARCHON_CODEX_CHATGPT_ACCESS_TOKEN',
  chatgptAccountId: 'ARCHON_CODEX_CHATGPT_ACCOUNT_ID',
} as const;
