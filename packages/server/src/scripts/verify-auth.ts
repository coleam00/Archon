/**
 * Container-startup auth verification hook (Layer 5).
 *
 * Runs `ensureFreshAuth` for both Claude and Codex sequentially at boot.
 * If credentials are stale, refresh proactively so the first workflow / chat
 * after a long-stopped container doesn't pay the refresh cost.
 *
 * Behavior contract:
 *   - MUST NEVER block container boot. Any throw is caught + logged; exit 0.
 *   - MUST NEVER print raw token values (redaction is enforced by the
 *     underlying preflight + refresh modules; this script does not log
 *     creds itself).
 *   - MUST emit `container_startup_auth_verify` exactly once per provider.
 *
 * Wired in via docker-entrypoint.sh BEFORE `bun run start`.
 * Behavior spec v2 invariant D-2; research doc §Design recommendation L5.
 */
import { createLogger } from '@archon/paths';
import { ensureFreshAuth } from '@archon/providers/auth-refresh';
import type { ProviderName } from '@archon/providers/auth-refresh';

const log = createLogger('verify-auth');

async function verifyOne(provider: ProviderName): Promise<void> {
  try {
    await ensureFreshAuth(provider);
    log.info({ provider, result: 'ok' }, 'container_startup_auth_verify');
  } catch (err) {
    // Never block boot. Surface the failure for ops visibility but exit 0
    // so the container starts. The reactive refresh path (PR #48) still
    // catches the first workflow's 401 — this is purely preventative.
    log.warn(
      { provider, result: 'failed', err: (err as Error).message },
      'container_startup_auth_verify'
    );
  }
}

async function main(): Promise<void> {
  await verifyOne('claude');
  await verifyOne('codex');
}

void main()
  .catch(err => {
    log.warn({ err: (err as Error).message }, 'container_startup_auth_verify_unexpected');
  })
  .finally(() => {
    // Bun keeps the process alive if any async work is pending; explicitly
    // exit to release the entrypoint so `bun run start` can begin.
    process.exit(0);
  });
