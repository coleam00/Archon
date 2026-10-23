import { relative } from 'path';
import { listWorktrees, execFileAsync, toRepoPath } from '@archon/git';
import {
  getIsolationProvider,
  readWorktreeCreationId,
  WorktreeUncommittedChangesError,
} from '@archon/isolation';
import { getArchonWorkspacesPath } from '@archon/paths';
import { type Conversation, type CommandResult, ConversationNotFoundError } from '../../types';
import * as db from '../../db/conversations';
import * as codebaseDb from '../../db/codebases';
import * as sessionDb from '../../db/sessions';
import * as isolationEnvDb from '../../db/isolation-environments';
import { cleanupStaleWorktrees } from '../../services/cleanup-service';
import { cleanupMergedWorktrees } from '../../services/cleanup/merged-sweep';
import { getLiveRunBlocker } from '../../services/cleanup/run-lock';
import { ensureIsolationConfigured } from '../../orchestrator/dispatch/isolation-resolver';
import { createRegisteredWorktree } from '../../workflows/registered-worktree';
import { safeDeactivateSession } from '../../state/session-transitions';
import { getLog } from './log';

/** The project a `/worktree` subcommand acts on: its id and its main checkout. */
interface WorktreeProject {
  codebaseId: string;
  name: string;
  mainPath: string;
}

/**
 * Convert an absolute path to a relative path from the repository root
 * Falls back to showing relative to workspace if not in a git repo
 */
function shortenPath(absolutePath: string, repoRoot?: string): string {
  // If we have a repo root, show path relative to it
  if (repoRoot) {
    const relPath = relative(repoRoot, absolutePath);
    // Only use relative path if it doesn't start with '..' (i.e., it's within the repo)
    if (!relPath.startsWith('..')) {
      return relPath;
    }
  }

  // Fallback: show relative to workspace
  const workspacePath = getArchonWorkspacesPath();
  const relPath = relative(workspacePath, absolutePath);
  if (!relPath.startsWith('..')) {
    return relPath;
  }

  // If all else fails, return the original path
  return absolutePath;
}

export async function handleWorktreeCommand(
  conversation: Conversation,
  args: string[]
): Promise<CommandResult> {
  if (!conversation.codebase_id) {
    return {
      success: false,
      message: 'No codebase configured. Register a project first with /register-project.',
    };
  }

  const codebase = await codebaseDb.getCodebase(conversation.codebase_id);
  if (!codebase) {
    return { success: false, message: 'Codebase not found.' };
  }

  // Worktrees are a git-repo concept — folder projects run in place and have no
  // worktree lifecycle. Reject clearly rather than failing deep in git.
  if (codebase.kind === 'folder') {
    return {
      success: false,
      message: `/worktree is not applicable to folder projects. "${codebase.name}" runs in place (no git worktree).`,
    };
  }

  const project: WorktreeProject = {
    codebaseId: conversation.codebase_id,
    name: codebase.name,
    mainPath: codebase.default_cwd,
  };

  switch (args[0]) {
    case 'create':
      return createWorktree(conversation, project, args[1]);
    case 'list':
      return listConversationWorktrees(conversation, project.mainPath);
    case 'remove':
      return removeWorktree(conversation, project.mainPath, args[1] === '--force');
    case 'orphans':
      return listGitWorktrees(conversation, project.mainPath);
    case 'cleanup':
      return cleanupWorktrees(project, args[1]);
    default:
      return {
        success: false,
        message:
          'Usage:\n  /worktree create <branch>\n  /worktree list\n  /worktree remove [--force]\n  /worktree cleanup merged|stale\n  /worktree orphans',
      };
  }
}

/** The working path of the worktree this conversation is in, or null when it is in none. */
async function currentWorktreePath(conversation: Conversation): Promise<string | null> {
  if (!conversation.isolation_env_id) return null;
  const currentEnv = await isolationEnvDb.getById(conversation.isolation_env_id);
  return currentEnv?.working_path ?? null;
}

async function createWorktree(
  conversation: Conversation,
  { codebaseId, name, mainPath }: WorktreeProject,
  branchName: string | undefined
): Promise<CommandResult> {
  if (!branchName) {
    return { success: false, message: 'Usage: /worktree create <branch-name>' };
  }

  // Check if already using a worktree
  if (conversation.isolation_env_id) {
    const existingEnv = await isolationEnvDb.getById(conversation.isolation_env_id);
    const worktreeLabel = existingEnv
      ? shortenPath(existingEnv.working_path, mainPath)
      : conversation.isolation_env_id;
    return {
      success: false,
      message: `Already using worktree: ${worktreeLabel}\n\nRun /worktree remove first.`,
    };
  }

  // Validate branch name (alphanumeric, dash, underscore only)
  if (!/^[a-zA-Z0-9_-]+$/.test(branchName)) {
    return {
      success: false,
      message: 'Branch name must contain only letters, numbers, dashes, and underscores.',
    };
  }

  try {
    ensureIsolationConfigured();
    const { env, envId } = await createRegisteredWorktree(isolationEnvDb, {
      request: {
        codebaseId,
        codebaseName: name,
        canonicalRepoPath: toRepoPath(mainPath),
        workflowType: 'task',
        identifier: branchName,
        description: `Manual worktree: ${branchName}`,
      },
      workflowId: `task-${branchName}`,
      createdByPlatform: conversation.platform_type,
    });

    await db.updateConversation(conversation.id, {
      isolation_env_id: envId,
      cwd: env.workingPath,
    });

    // NOTE: Do NOT deactivate session - preserve AI context per plan

    const shortPath = shortenPath(env.workingPath, mainPath);
    return {
      success: true,
      message: `Worktree created!\n\nBranch: ${env.branchName}\nPath: ${shortPath}\n\nThis conversation now works in isolation.\nRun dependency install if needed (e.g., bun install).`,
      modified: true,
    };
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, branch: branchName }, 'cmd.worktree_create_failed');

    // Check for common errors
    if (error instanceof ConversationNotFoundError) {
      return {
        success: false,
        message: 'Failed to create worktree: conversation state changed. Please try again.',
      };
    }
    return { success: false, message: err.message };
  }
}

async function listConversationWorktrees(
  conversation: Conversation,
  mainPath: string
): Promise<CommandResult> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', mainPath, 'worktree', 'list']);

    // Resolve the current worktree's working path from the DB (isolation_env_id is a UUID)
    const activePath = await currentWorktreePath(conversation);

    // Parse output and mark current
    const lines = stdout.trim().split('\n');
    let msg = 'Worktrees:\n\n';

    for (const line of lines) {
      // Extract the path (first part before whitespace)
      const parts = line.split(/\s+/);
      const fullPath = parts[0];
      const shortPath = shortenPath(fullPath, mainPath);

      // Reconstruct line with shortened path
      const restOfLine = parts.slice(1).join(' ');
      const shortenedLine = restOfLine ? `${shortPath} ${restOfLine}` : shortPath;

      const isActive = activePath && fullPath === activePath;
      const marker = isActive ? ' <- active' : '';
      msg += `${shortenedLine}${marker}\n`;
    }

    return { success: true, message: msg };
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, mainPath }, 'cmd.worktree_list_failed');
    return { success: false, message: `Failed to list worktrees: ${err.message}` };
  }
}

async function removeWorktree(
  conversation: Conversation,
  mainPath: string,
  forceFlag: boolean
): Promise<CommandResult> {
  const isolationEnvId = conversation.isolation_env_id;
  if (!isolationEnvId) {
    return { success: false, message: 'This conversation is not using a worktree.' };
  }

  // Look up the isolation environment to get the working path
  const isolationEnv = await isolationEnvDb.getById(isolationEnvId);
  if (!isolationEnv) {
    return { success: false, message: 'Isolation environment not found in database.' };
  }

  if (isolationEnv.provider !== 'worktree') {
    return {
      success: false,
      message:
        'This environment is not a worktree. Use `archon isolation cleanup 0` for container cleanup.',
    };
  }

  try {
    const liveRun = await getLiveRunBlocker(isolationEnvId);
    if (liveRun) {
      return {
        success: false,
        message: `Worktree kept: ${liveRun.display}. Resume or abandon the run before removing the worktree.`,
      };
    }

    // Use isolation provider for removal (pass the working path, not UUID)
    const provider = getIsolationProvider();
    if (isolationEnv.status === 'active')
      await isolationEnvDb.withWorktreeRegistration(isolationEnv, async markDestroyed => {
        const result = await provider.destroy(isolationEnv.working_path, {
          force: forceFlag,
          canonicalRepoPath: toRepoPath(mainPath),
          creationId: readWorktreeCreationId(isolationEnv.metadata) ?? undefined,
        });
        if (!result.worktreeRemoved || !result.directoryClean) {
          throw new Error(
            `Worktree removal incomplete; environment retained. ${result.warnings.join('; ')}`
          );
        }

        await markDestroyed();
      });

    // Clear isolation reference, set cwd to main repo
    await db.updateConversation(conversation.id, {
      isolation_env_id: null,
      cwd: mainPath,
    });

    // Reset session
    const session = await sessionDb.getActiveSession(conversation.id);
    if (session) {
      await safeDeactivateSession(session.id, 'worktree-remove');
    }

    const shortPath = shortenPath(isolationEnv.working_path, mainPath);
    return {
      success: true,
      message: `Worktree removed: ${shortPath}\n\nSwitched back to main repo.`,
      modified: true,
    };
  } catch (error) {
    const err = error as Error;
    getLog().error(
      { err, isolationEnvId, workingPath: isolationEnv.working_path },
      'cmd.worktree_remove_failed'
    );

    // Check for common errors
    if (error instanceof ConversationNotFoundError) {
      return {
        success: false,
        message: 'Failed to remove worktree: conversation state changed. Please try again.',
      };
    }
    // Provide friendly error for uncommitted changes
    if (error instanceof WorktreeUncommittedChangesError) {
      return {
        success: false,
        message:
          'Worktree has uncommitted changes.\n\nCommit your work first, or use `/worktree remove --force` to discard.',
      };
    }
    return { success: false, message: `Failed to remove worktree: ${err.message}` };
  }
}

/**
 * Show all worktrees from git's perspective (the source of truth). Useful for
 * discovering skill-created worktrees or stale entries.
 */
async function listGitWorktrees(
  conversation: Conversation,
  mainPath: string
): Promise<CommandResult> {
  try {
    const gitWorktrees = await listWorktrees(toRepoPath(mainPath));

    if (gitWorktrees.length <= 1) {
      return {
        success: true,
        message:
          'No worktrees found (only main repo).\n\nUse `/worktree create <branch>` to create one.',
      };
    }

    // Resolve working path from UUID for current marker
    const activePath = await currentWorktreePath(conversation);

    let msg = 'All worktrees (from git):\n\n';
    for (const wt of gitWorktrees) {
      const isMainRepo = wt.path === mainPath;
      if (isMainRepo) continue;

      const shortPath = shortenPath(wt.path, mainPath);
      const isCurrent = activePath && wt.path === activePath;
      const marker = isCurrent ? ' ← current' : '';
      msg += `  ${wt.branch} → ${shortPath}${marker}\n`;
    }

    msg += '\nNote: This shows ALL worktrees including those created by external tools.\n';
    msg += 'Git (`git worktree list`) is the source of truth.';

    return { success: true, message: msg };
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, mainPath }, 'cmd.worktree_orphans_failed');
    return { success: false, message: `Failed to list worktrees: ${err.message}` };
  }
}

async function cleanupWorktrees(
  { codebaseId, mainPath }: WorktreeProject,
  cleanupType: string | undefined
): Promise<CommandResult> {
  if (!cleanupType || !['merged', 'stale'].includes(cleanupType)) {
    return {
      success: false,
      message:
        'Usage:\n  /worktree cleanup merged - Remove worktrees with merged branches\n  /worktree cleanup stale - Remove inactive worktrees (14+ days)',
    };
  }

  try {
    let result;
    if (cleanupType === 'merged') {
      result = await cleanupMergedWorktrees(codebaseId, mainPath);
    } else {
      result = await cleanupStaleWorktrees(codebaseId, mainPath);
    }

    let msg = '';

    if (result.removed.length > 0) {
      msg += `Cleaned up ${String(result.removed.length)} ${cleanupType} worktree(s):\n`;
      for (const branch of result.removed) {
        msg += `  • ${branch}\n`;
      }
      for (const { branchName, runId, reason } of result.releasedFailedRuns) {
        msg += `  Released failed run ${runId.slice(0, 8)} (${reason}): ${branchName}\n`;
      }
    } else {
      msg += `No ${cleanupType} worktrees to clean up.\n`;
    }

    for (const { branchName, message } of result.warnings) {
      msg += `  Warning: ${branchName}: ${message}\n`;
    }

    if (result.skipped.length > 0) {
      msg += `\nSkipped ${String(result.skipped.length)} (protected):\n`;
      for (const { branchName, reason } of result.skipped) {
        msg += `  • ${branchName} (${reason})\n`;
      }
    }

    msg += result.errors
      .map(({ branchName, error }) => `  Failed: ${branchName} (${error})\n`)
      .join('');

    msg += `\n${await activeWorktreeCountMessage(codebaseId)}`;

    return { success: result.errors.length === 0, message: msg.trim() };
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, cleanupType, codebaseId: codebaseId }, 'cmd.worktree_cleanup_failed');
    return { success: false, message: `Failed to cleanup: ${err.message}` };
  }
}

async function activeWorktreeCountMessage(codebaseId: string): Promise<string> {
  try {
    const count = await isolationEnvDb.countActiveByCodebase(codebaseId);
    return `Active worktrees: ${String(count)}`;
  } catch (err) {
    getLog().warn({ err, codebaseId }, 'cmd.worktree_cleanup_count_failed');
    return `Active worktrees: unavailable (${(err as Error).message})`;
  }
}
