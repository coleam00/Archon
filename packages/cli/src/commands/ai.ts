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
import { password, isCancel, cancel } from '@clack/prompts';
import { createLogger } from '@archon/paths';
import {
  isPerUserProviderKeysEnabled,
  persistProviderApiKey,
  listUserProviderKeys,
  deleteUserProviderKey,
  KNOWN_PROVIDERS,
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

/** Reserved for PR-3 (Pi OAuth subscription bridge). */
export function aiLoginNotImplemented(): number {
  console.error(
    'OAuth subscription login (archon ai login) ships in a later release.\n' +
      'For now connect an API key: archon ai key set <provider>'
  );
  return 1;
}
