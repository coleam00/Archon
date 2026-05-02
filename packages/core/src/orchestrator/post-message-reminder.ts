/**
 * Post-message reminder: warn the user about unpushed work in source/.
 *
 * Background: with the non-destructive sync default (#1516), local commits and
 * uncommitted modifications in `source/` are now preserved across chat ticks
 * (good). However, the chat-mode agent does not auto-push on completion the way
 * workflow-mode does. Without an explicit reminder, users can accumulate
 * unpushed work in `source/` and lose it later — for example via:
 *  - A subsequent `/worktree create` (which uses `mode: 'reset'` for managed
 *    clones to ensure a clean base, discarding local commits)
 *  - Manual git operations from another terminal
 *  - Re-cloning the codebase
 *
 * This helper runs at the end of `handleMessage` for codebase-attached
 * conversations and emits a single non-blocking system_status SSE event when
 * `source/` has unpushed commits or uncommitted modifications.
 */

import { createLogger } from '@archon/paths';
import { countCommitsAhead, hasUncommittedChanges, toRepoPath, toBranchName } from '@archon/git';
import type { IPlatformAdapter } from '../types';
import type { Codebase } from '../types';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('orchestrator.post-message-reminder');
  return cachedLog;
}

/**
 * Inspect `codebase.default_cwd` for unpushed work and emit a single advisory
 * `system_status` event if anything is at risk of being lost on the next
 * destructive sync (e.g. `/worktree create`).
 *
 * Non-fatal: any error is logged at debug and swallowed — this is an advisory
 * UX feature, not a safety boundary.
 */
export async function reportUnpushedWorkInSource(
  platform: IPlatformAdapter,
  conversationId: string,
  codebase: Codebase
): Promise<void> {
  if (!platform.sendStructuredEvent) return;

  const sourcePath = toRepoPath(codebase.default_cwd);
  const branchName = codebase.default_branch ? toBranchName(codebase.default_branch) : null;

  try {
    const dirty = await hasUncommittedChanges(sourcePath);
    // If we don't know the branch, we can't compare to origin/<branch>.
    // Skip the unpushed-commits check; only the dirty bit is informative.
    const aheadCount = branchName ? await countCommitsAhead(sourcePath, branchName) : 0;

    if (aheadCount === 0 && !dirty) return;

    const parts: string[] = [];
    if (aheadCount > 0) {
      parts.push(`${String(aheadCount)} unpushed commit${aheadCount === 1 ? '' : 's'}`);
    } else if (aheadCount === -1) {
      parts.push('unpushed local branch');
    }
    if (dirty) {
      parts.push('uncommitted changes');
    }

    const summary = parts.join(' and ');
    const branchLabel = branchName ? ` on ${branchName}` : '';
    await platform.sendStructuredEvent(conversationId, {
      type: 'system',
      content: `source/ has ${summary}${branchLabel}. Push or commit + push to preserve — local-only state may be lost on the next worktree creation, manual checkout, or re-clone.`,
    });
  } catch (err) {
    getLog().debug(
      { err: err as Error, codebaseId: codebase.id },
      'post_message_reminder.check_failed'
    );
  }
}
