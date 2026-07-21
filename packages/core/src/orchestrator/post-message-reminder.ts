/**
 * Post-message reminder: if the AI just wrote to a managed `source/` directory
 * (Archon-managed clone under ~/.archon/workspaces/) and there is local-only
 * state — unpushed commits or uncommitted edits — surface a single status
 * event so the user knows they need to push or commit + push before the next
 * worktree creation, manual checkout, or re-clone reclaims that work.
 *
 * Non-fatal by construction: any failure is logged at warn and swallowed.
 * This runs after the assistant turn completes, so an error here must never
 * obscure the message the user just received.
 */
import {
  countCommitsAhead,
  getCurrentBranch,
  hasUncommittedChanges,
  toRepoPath,
} from '@archon/git';
import { createLogger, getArchonWorkspacesPath } from '@archon/paths';
import type { Codebase, IPlatformAdapter } from '../types';

const log = createLogger('orchestrator.post_message_reminder');

export async function reportUnpushedWorkInSource(
  conversationId: string,
  codebase: Codebase,
  platform: IPlatformAdapter
): Promise<void> {
  if (!platform.sendStructuredEvent) return;

  // Only meaningful for Archon-managed clones under ~/.archon/workspaces/.
  // Locally-registered repos are the user's working dir — they already see git status.
  const archonWorkspacesPath = getArchonWorkspacesPath().replace(/\\/g, '/');
  const cwdNormalized = codebase.default_cwd.replace(/\\/g, '/');
  if (!cwdNormalized.startsWith(archonWorkspacesPath)) return;

  const repoPath = toRepoPath(codebase.default_cwd);
  try {
    const branch = await getCurrentBranch(repoPath);
    if (!branch) return;

    const [ahead, dirty] = await Promise.all([
      countCommitsAhead(repoPath, branch),
      hasUncommittedChanges(repoPath),
    ]);
    if (ahead === 0 && !dirty) return;

    const parts: string[] = [];
    if (ahead > 0) parts.push(`${ahead} unpushed commit${ahead === 1 ? '' : 's'}`);
    if (dirty) parts.push('uncommitted changes');

    await platform.sendStructuredEvent(conversationId, {
      type: 'system',
      content:
        `source/ has ${parts.join(' and ')} on ${branch}. ` +
        'Push or commit + push to preserve — local-only state may be lost on the next worktree creation, manual checkout, or re-clone.',
    });
  } catch (err) {
    log.warn(
      { err: err as Error, conversationId, codebaseId: codebase.id },
      'post_message_reminder_failed'
    );
  }
}
