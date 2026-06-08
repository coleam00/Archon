/**
 * `archon ai` — manage the current CLI user's per-user AI-provider credentials.
 *
 *   archon ai key set <provider>   Connect an API key (read from masked prompt or piped stdin)
 *   archon ai list                 List connected providers (metadata only, no secrets)
 *   archon ai logout <provider>    Disconnect a provider
 *   archon ai login <provider>     (reserved — OAuth subscription login ships in a later release)
 *
 * Gated on TOKEN_ENCRYPTION_KEY (isPerUserProviderKeysEnabled). Solo installs
 * keep reading provider keys from the environment unchanged.
 *
 * The API key is NEVER taken from argv (it would leak into shell history and the
 * process list). It is read from a masked `@clack/prompts` password input on a
 * TTY, or from piped stdin (`echo $KEY | archon ai key set openrouter`).
 *
 * CLI identity mirrors `archon auth github`: ARCHON_USER_ID (explicit) else
 * $USER/$USERNAME, resolved to a stable Archon user via the 'cli' platform
 * identity so a connected key attaches to the same user across invocations.
 */
import { password, text, isCancel, cancel } from '@clack/prompts';
import { createLogger } from '@archon/paths';
import {
  isPerUserProviderKeysEnabled,
  persistProviderApiKey,
  listUserProviderKeys,
  deleteUserProviderKey,
  KNOWN_PROVIDERS,
  SUBSCRIPTION_PROVIDERS,
  startOAuth,
  pollOAuth,
} from '@archon/core';
import * as userDb from '@archon/core/db/users';
import { resolveCliUserId } from './auth';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('cli.ai');
  return cachedLog;
}

function knownProvidersList(): string {
  return [...KNOWN_PROVIDERS].sort().join(', ');
}

/** Print the gate explanation and return false when per-user keys are off. */
function ensureEnabled(): boolean {
  if (!isPerUserProviderKeysEnabled()) {
    console.error(
      'Per-user AI provider keys are not enabled on this install.\n' +
        'Set TOKEN_ENCRYPTION_KEY (64-char hex) to enable encrypted per-user credentials.\n' +
        'Solo installs keep reading keys (CLAUDE_API_KEY / OPENAI_API_KEY / …) from the environment.'
    );
    return false;
  }
  return true;
}

/** Resolve the CLI identity to an Archon user row, or print why we can't. */
async function resolveUser(): Promise<{ id: string } | null> {
  const cliId = resolveCliUserId();
  if (!cliId) {
    console.error('Could not determine your CLI identity. Set ARCHON_USER_ID (or $USER).');
    return null;
  }
  return await userDb.findOrCreateUserByPlatformIdentity('cli', cliId, cliId);
}

/**
 * Read the secret from piped stdin (non-TTY) or a masked prompt — never argv.
 * Returns `null` when there is no usable key (prompt cancelled, or empty stdin —
 * the message is printed here); a non-null result is always a non-blank key.
 */
async function readApiKey(provider: string): Promise<string | null> {
  if (!process.stdin.isTTY) {
    const piped = (await Bun.stdin.text()).trim();
    if (!piped) {
      console.error('No API key provided on stdin.');
      return null;
    }
    return piped;
  }
  const entered = await password({
    message: `Paste your API key for '${provider}':`,
    validate: v => (v?.trim() ? undefined : 'API key must not be empty.'),
  });
  if (isCancel(entered)) {
    cancel('Cancelled.');
    return null;
  }
  return entered.trim();
}

export async function aiKeySetCommand(provider: string | undefined): Promise<number> {
  if (!ensureEnabled()) return 1;
  if (!provider) {
    console.error('Usage: archon ai key set <provider>');
    console.error(`Providers: ${knownProvidersList()}`);
    return 1;
  }
  if (!KNOWN_PROVIDERS.has(provider)) {
    console.error(`Unknown provider '${provider}'. Known: ${knownProvidersList()}.`);
    return 1;
  }
  const user = await resolveUser();
  if (!user) return 1;

  const apiKey = await readApiKey(provider);
  if (apiKey === null) return 1; // cancelled or empty (message already printed)

  try {
    const result = await persistProviderApiKey(user.id, provider, apiKey);
    console.log(
      `✓ Stored an ${result.kind} for '${result.provider}' (encrypted). ` +
        'It will be injected into your runs and chats.'
    );
    return 0;
  } catch (err) {
    getLog().error({ err: err as Error, provider }, 'cli.ai_key_set_failed');
    console.error(`✗ ${(err as Error).message}`);
    return 1;
  }
}

export async function aiListCommand(): Promise<number> {
  if (!ensureEnabled()) return 1;
  const user = await resolveUser();
  if (!user) return 1;

  try {
    const rows = await listUserProviderKeys(user.id);
    if (rows.length === 0) {
      console.log('No AI provider keys connected. Add one with: archon ai key set <provider>');
      return 0;
    }
    console.log('Connected AI provider credentials:');
    for (const r of rows) {
      const label = r.label ? ` — ${r.label}` : '';
      console.log(`  ${r.provider}  (${r.kind})${label}`);
    }
    return 0;
  } catch (err) {
    getLog().error({ err: err as Error }, 'cli.ai_list_failed');
    console.error(`✗ Failed to list provider keys: ${(err as Error).message}`);
    return 1;
  }
}

export async function aiLogoutCommand(provider: string | undefined): Promise<number> {
  if (!ensureEnabled()) return 1;
  if (!provider) {
    console.error('Usage: archon ai logout <provider>');
    return 1;
  }
  // Guard typos consistently with `key set` — a misspelled provider should be a
  // visible error, not a no-op that prints "✓ Disconnected".
  if (!KNOWN_PROVIDERS.has(provider)) {
    console.error(`Unknown provider '${provider}'. Known: ${knownProvidersList()}.`);
    return 1;
  }
  const user = await resolveUser();
  if (!user) return 1;

  try {
    await deleteUserProviderKey(user.id, provider);
    console.log(`✓ Disconnected '${provider}'.`);
    return 0;
  } catch (err) {
    getLog().error({ err: err as Error, provider }, 'cli.ai_logout_failed');
    console.error(`✗ Failed to disconnect '${provider}': ${(err as Error).message}`);
    return 1;
  }
}

function subscriptionProvidersList(): string {
  return [...SUBSCRIPTION_PROVIDERS].sort().join(', ');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * `archon ai login <provider>` — connect a subscription (Claude Pro/Max,
 * ChatGPT/Codex, GitHub Copilot) via Pi's OAuth, driven in-process through the
 * bridge. Manual-code providers (claude/codex) print a URL and prompt for the
 * pasted code; device-code (copilot) prints a user-code and polls.
 */
export async function aiLoginCommand(provider: string | undefined): Promise<number> {
  if (!ensureEnabled()) return 1;
  if (!provider) {
    console.error('Usage: archon ai login <provider>');
    console.error(`Subscription providers: ${subscriptionProvidersList()}`);
    return 1;
  }
  if (!SUBSCRIPTION_PROVIDERS.has(provider)) {
    console.error(
      `Provider '${provider}' does not support subscription login. ` +
        `Subscription providers: ${subscriptionProvidersList()}.`
    );
    return 1;
  }
  const user = await resolveUser();
  if (!user) return 1;

  try {
    const start = await startOAuth(user.id, provider);
    if (start.mode === 'device') {
      console.log(
        `\n→ Visit ${start.verificationUri ?? '(pending)'} and enter code: ${start.userCode ?? '(pending)'}`
      );
      console.log('→ Waiting for authorization…');
      return await pollLoginLoop(start.sessionId, user.id, provider);
    }
    // manual-code (Anthropic / Codex)
    if (start.url) console.log(`\n→ Visit: ${start.url}`);
    console.log('→ Authorize in your browser, then paste the code shown back here.');
    const code = await text({
      message: 'Paste the authorization code:',
      validate: v => (v?.trim() ? undefined : 'Authorization code is required.'),
    });
    if (isCancel(code)) {
      cancel('Cancelled.');
      return 1;
    }
    return await pollLoginLoop(start.sessionId, user.id, provider, code.trim());
  } catch (err) {
    getLog().error({ err: err as Error, provider }, 'cli.ai_login_failed');
    console.error(`✗ ${(err as Error).message}`);
    return 1;
  }
}

/** Poll the in-process bridge until the login is connected/failed/timed out. */
async function pollLoginLoop(
  sessionId: string,
  userId: string,
  provider: string,
  code?: string
): Promise<number> {
  const MAX_POLLS = 150; // ~5 min at 2s
  // The pasted code is submitted on the first poll only; later polls just check status.
  let pendingCode = code;
  for (let i = 0; i < MAX_POLLS; i++) {
    const res = pollOAuth(sessionId, userId, pendingCode);
    pendingCode = undefined;
    if (res.status === 'connected') {
      console.log(`\n✓ Connected '${provider}' subscription. Stored encrypted in Archon's DB.`);
      return 0;
    }
    if (res.status === 'error') {
      console.error(`\n✗ ${res.detail ?? 'Subscription login failed.'}`);
      return 1;
    }
    await sleep(2000);
  }
  console.error('\n✗ Subscription login timed out.');
  return 1;
}
