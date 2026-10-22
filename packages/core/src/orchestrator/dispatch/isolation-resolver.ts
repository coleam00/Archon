// The conversation's isolation: the resolver singleton, and validateAndResolveIsolation,
// which applies the resolver's verdict to the conversation and tells the user about it.
import type { WorktreeSetupExecutor } from '@archon/isolation';
import type { IsolationHints, IsolationEnvironmentRow, ResolvedIsolation } from '@archon/isolation';
import { IsolationBlockedError, IsolationResolver, getIsolationProvider } from '@archon/isolation';
import { createLogger } from '@archon/paths';
import { toBranchName } from '@archon/git';
import type { OwnedWorktree } from '@archon/workflows/schemas/workflow-run';
import { IPlatformAdapter, Conversation, Codebase, ConversationNotFoundError } from '../../types';
import * as db from '../../db/conversations';
import { createIsolationStore } from '../../db/isolation-environments';
import { toError } from '../../utils/error';
import { configureWorktreeIsolation } from '../../workflows/worktree-setup';
import { getWorktreeStatusBreakdown, STALE_THRESHOLD_DAYS } from '../../services/cleanup-service';
import { cleanupToMakeRoom } from '../../services/cleanup/merged-sweep';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('orchestrator');
  return cachedLog;
}

export type IsolationResolution =
  | { status: 'existing'; cwd: string; env: IsolationEnvironmentRow }
  | {
      status: 'new';
      ownedWorktree?: OwnedWorktree;
      cwd: string;
      env: IsolationEnvironmentRow;
      /** The commit a branch created by this resolution was cut from. */
      cutFromCommit?: string;
    }
  | { status: 'none'; cwd: string; env: null };

// Lazy resolver singleton
let resolver: IsolationResolver | null = null;
let isolationConfigured = false;

export function ensureIsolationConfigured(): void {
  if (!isolationConfigured) {
    configureWorktreeIsolation();
    isolationConfigured = true;
  }
}

function getResolver(): IsolationResolver {
  ensureIsolationConfigured();
  if (!resolver) {
    resolver = new IsolationResolver({
      store: createIsolationStore(),
      provider: getIsolationProvider(),
      cleanup: {
        makeRoom: async (codebaseId, repoPath): Promise<{ removedCount: number }> => {
          const result = await cleanupToMakeRoom(codebaseId, repoPath);
          return { removedCount: result.removed.length };
        },
        getBreakdown: getWorktreeStatusBreakdown,
      },
      staleThresholdDays: STALE_THRESHOLD_DAYS,
    });
  }
  return resolver;
}

/**
 * Validate existing isolation reference and coordinate creation of new isolation if needed.
 * Delegates resolution logic to IsolationResolver; handles messaging and conversation updates.
 *
 * @throws {IsolationBlockedError} When isolation is required but blocked (user already notified)
 */
export async function validateAndResolveIsolation(
  conversation: Conversation,
  codebase: Codebase | null,
  platform: IPlatformAdapter,
  conversationId: string,
  hints?: IsolationHints,
  _isRetry = false,
  userId?: string,
  setupExecutor?: WorktreeSetupExecutor
): Promise<IsolationResolution> {
  const result = await getResolver().resolve({
    setupExecutor,
    existingEnvId: conversation.isolation_env_id,
    codebase: codebase
      ? {
          id: codebase.id,
          defaultCwd: codebase.default_cwd,
          name: codebase.name,
          defaultBranch: codebase.default_branch?.trim()
            ? toBranchName(codebase.default_branch.trim())
            : null,
          kind: codebase.kind,
        }
      : null,
    hints,
    platformType: platform.getPlatformType(),
    userId,
  });

  switch (result.status) {
    case 'resolved':
      await linkResolvedEnvironment(conversation, result);
      await sendResolutionNotices(platform, conversationId, result);
      return toIsolationResolution(result);

    case 'stale_cleaned': {
      await clearStaleReference(conversation, codebase, platform, conversationId);
      // Retry without existing env (guard against infinite recursion)
      if (!codebase) return { status: 'none', cwd: conversation.cwd ?? '/workspace', env: null };
      if (_isRetry) {
        throw new Error(
          `Isolation resolution stuck in stale_cleaned loop for conversation ${conversation.id}`
        );
      }
      return validateAndResolveIsolation(
        { ...conversation, isolation_env_id: null },
        codebase,
        platform,
        conversationId,
        hints,
        true,
        userId,
        setupExecutor
      );
    }

    case 'none':
      return { status: 'none', cwd: result.cwd, env: null };

    case 'blocked':
      await platform.sendMessage(conversationId, result.userMessage);
      throw new IsolationBlockedError(
        'Isolation environment required but could not be created',
        result.reason
      );
  }
}

/** Link env to conversation; a failed link releases the environment the resolver made. */
async function linkResolvedEnvironment(
  conversation: Conversation,
  result: ResolvedIsolation
): Promise<void> {
  try {
    await db.updateConversation(conversation.id, {
      isolation_env_id: result.env.id,
      cwd: result.cwd,
    });
  } catch (updateError) {
    const err = toError(updateError);
    getLog().error(
      { err, conversationId: conversation.id, isolationEnvId: result.env.id },
      'isolation_link_failed'
    );
    await getResolver().releaseUnlinked(result);
    throw err;
  }
}

async function sendResolutionNotices(
  platform: IPlatformAdapter,
  conversationId: string,
  result: ResolvedIsolation
): Promise<void> {
  if (result.method.type === 'linked_issue_reuse') {
    await platform.sendMessage(
      conversationId,
      `Reusing worktree from issue #${String(result.method.issueNumber)}`
    );
  }
  if (result.method.type === 'created' && result.method.autoCleanedCount) {
    await platform.sendMessage(
      conversationId,
      `Cleaned up ${String(result.method.autoCleanedCount)} merged worktree(s) to make room.`
    );
  }
  // Surface any non-fatal warnings from environment creation
  for (const warning of result.warnings ?? []) {
    await platform.sendMessage(conversationId, `Warning: ${warning}`).catch(e => {
      getLog().error({ err: toError(e), conversationId }, 'isolation_warning_send_failed');
    });
  }
}

function toIsolationResolution(result: ResolvedIsolation): IsolationResolution {
  if (result.method.type === 'existing') {
    return { status: 'existing', cwd: result.cwd, env: result.env };
  }
  const created = result.method.type === 'created' ? result.method : undefined;
  return {
    status: 'new',
    ...(created ? { ownedWorktree: { envId: result.env.id, creationId: created.creationId } } : {}),
    cwd: result.cwd,
    env: result.env,
    ...(created?.cutFromCommit !== undefined ? { cutFromCommit: created.cutFromCommit } : {}),
  };
}

async function clearStaleReference(
  conversation: Conversation,
  codebase: Codebase | null,
  platform: IPlatformAdapter,
  conversationId: string
): Promise<void> {
  await db.updateConversation(conversation.id, { isolation_env_id: null }).catch(e => {
    if (!(toError(e) instanceof ConversationNotFoundError)) {
      getLog().error(
        { err: toError(e), conversationId: conversation.id },
        'stale_isolation_clear_failed'
      );
    }
  });
  const staleMsg = codebase
    ? 'Detected a stale isolated workspace reference and cleared it. Creating a new isolated workspace now.'
    : 'Detected a stale isolated workspace reference and cleared it. Continuing without an isolated workspace.';
  await platform.sendMessage(conversationId, staleMsg).catch(e => {
    getLog().error({ err: toError(e), conversationId }, 'stale_isolation_notice_failed');
  });
}
