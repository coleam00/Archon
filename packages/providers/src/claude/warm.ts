/**
 * Pre-warm the Claude Code subprocess so the first workflow query has minimal latency.
 *
 * `startup()` is exported from @anthropic-ai/claude-agent-sdk v0.2.89+ at runtime but
 * is not yet declared in the package's TypeScript declarations. The cast is intentional.
 */
import { createLogger } from '@archon/paths';

const log = createLogger('providers.claude');

export async function warmClaudeSubprocess(): Promise<void> {
  try {
    // startup() exists at runtime in @anthropic-ai/claude-agent-sdk v0.2.89+ but is
    // not yet declared in the package's TypeScript declarations. Cast is intentional.
    const sdk = (await import('@anthropic-ai/claude-agent-sdk')) as {
      startup?: () => Promise<void>;
    };
    if (typeof sdk.startup !== 'function') {
      log.debug('claude.warm_skipped — startup() not available in this SDK version');
      return;
    }
    await sdk.startup();
    log.info('claude.warm_completed');
  } catch (err) {
    log.warn({ err }, 'claude.warm_failed — continuing without pre-warm');
  }
}
