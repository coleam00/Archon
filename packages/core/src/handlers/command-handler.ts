/**
 * Command handler for slash commands
 * Handles deterministic operations without AI
 */
import { writeFile, access } from 'fs/promises';
import { join, relative } from 'path';
import { type Conversation, type CommandResult, ConversationNotFoundError } from '../types';
import * as db from '../db/conversations';
import * as codebaseDb from '../db/codebases';
import * as sessionDb from '../db/sessions';
import { listWorktrees, execFileAsync, toRepoPath } from '@archon/git';
import { getIsolationProvider } from '@archon/isolation';
import * as isolationEnvDb from '../db/isolation-environments';
import {
  cleanupMergedWorktrees,
  cleanupStaleWorktrees,
  getWorktreeStatusBreakdown,
} from '../services/cleanup-service';
import { getArchonWorkspacesPath } from '@archon/paths';
import { loadConfig } from '../config/config-loader';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { resolveWorkflowName } from '@archon/workflows/router';
import type {
  WorkflowWithSource,
  WorkflowLoadError,
  WorkflowDefinition,
} from '@archon/workflows/schemas/workflow';
import * as workflowDb from '../db/workflows';
import {
  approveWorkflow,
  rejectWorkflow,
  getWorkflowStatus,
  resumeWorkflow,
  abandonWorkflow,
} from '../operations/workflow-operations';
import { getTriggerForCommand, type DeactivatingCommand } from '../state/session-transitions';
import { SessionNotFoundError } from '../db/sessions';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('command-handler');
  return cachedLog;
}

/**
 * Workflow timing information calculated from database values
 */
interface WorkflowTimingInfo {
  startedAt: Date;
  lastActivity: Date;
  durationMs: number;
  durationMin: number;
  durationSec: number;
  lastActivityMs: number;
  lastActivityMin: number;
  lastActivitySec: number;
  isValid: boolean;
}

/**
 * Calculate timing information for a workflow run
 * Handles invalid dates gracefully and prevents negative durations
 */
function calculateWorkflowTiming(workflow: {
  started_at: Date | string;
  last_activity_at: Date | string | null;
}): WorkflowTimingInfo {
  const startedAt = new Date(workflow.started_at);
  const lastActivity = workflow.last_activity_at ? new Date(workflow.last_activity_at) : startedAt;

  // Validate dates - check for Invalid Date
  const isValid = !isNaN(startedAt.getTime()) && !isNaN(lastActivity.getTime());

  // Use Math.max(0, ...) to prevent negative durations from clock skew or data corruption
  const durationMs = Math.max(0, Date.now() - startedAt.getTime());
  const lastActivityMs = Math.max(0, Date.now() - lastActivity.getTime());

  return {
    startedAt,
    lastActivity,
    durationMs,
    durationMin: Math.floor(durationMs / 60000),
    durationSec: Math.floor((durationMs % 60000) / 1000),
    lastActivityMs,
    lastActivityMin: Math.floor(lastActivityMs / 60000),
    lastActivitySec: Math.floor((lastActivityMs % 60000) / 1000),
    isValid,
  };
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

/**
 * Get the current git branch name for a repository.
 * Returns 'unknown' if git command fails, with error logged for debugging.
 *
 * @returns Branch name, 'detached HEAD', or 'unknown'. Never throws.
 */
async function getCurrentBranch(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { timeout: 3000 }
    );
    const branch = stdout.trim();
    // Handle detached HEAD state - git returns literal "HEAD"
    return branch === 'HEAD' ? 'detached HEAD' : branch;
  } catch (error) {
    getLog().debug({ err: error, repoPath }, 'get_branch_failed');
    return 'unknown';
  }
}

/**
 * Format repository context for user-facing display.
 * Shows "owner/repo @ branch" instead of filesystem paths.
 *
 * @returns Formatted context string. Never throws - falls back gracefully on errors.
 */
async function formatRepoContext(
  codebase: { name: string; default_cwd: string } | null,
  isolationEnvId: string | null
): Promise<string> {
  if (!codebase) {
    return 'No codebase configured';
  }

  // If in a worktree, use the worktree's branch name from database
  if (isolationEnvId) {
    try {
      const env = await isolationEnvDb.getById(isolationEnvId);
      if (env?.branch_name) {
        return `${codebase.name} @ ${env.branch_name} (worktree)`;
      }
      // Log data integrity issue - isolation_env_id exists but record missing or incomplete
      getLog().warn(
        { isolationEnvId, found: !!env, hasBranchName: !!env?.branch_name },
        'isolation_env_incomplete'
      );
      // Fallthrough to git branch detection
    } catch (error) {
      getLog().error({ err: error, isolationEnvId }, 'isolation_env_lookup_failed');
      // Fallthrough to git branch detection on DB error
    }
  }

  // Not in worktree or worktree lookup failed - get branch from git
  const branchName = await getCurrentBranch(codebase.default_cwd);
  return `${codebase.name} @ ${branchName}`;
}

export function parseCommand(text: string): { command: string; args: string[] } {
  // Match quoted strings or non-whitespace sequences
  const matches = text.match(/"[^"]+"|'[^']+'|\S+/g) ?? [];

  if (matches.length === 0 || !matches[0]) {
    return { command: '', args: [] };
  }

  if (!matches[0].startsWith('/')) {
    return { command: '', args: [] };
  }

  const command = matches[0].substring(1); // Remove leading '/'
  const args = matches.slice(1).map(arg => {
    // Remove surrounding quotes if present
    if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
      return arg.slice(1, -1);
    }
    return arg;
  });

  return { command, args };
}

/**
 * Safely deactivate a session with TOCTOU race handling.
 * Between getActiveSession() and deactivateSession(), another process
 * (cleanup service, concurrent command) may have already deactivated it.
 * Treats SessionNotFoundError as benign in that case.
 */
async function safeDeactivateSession(
  sessionId: string,
  commandName: DeactivatingCommand
): Promise<void> {
  const trigger = getTriggerForCommand(commandName);
  try {
    await sessionDb.deactivateSession(sessionId, trigger);
    getLog().debug({ sessionId, trigger }, 'session_deactivated');
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      getLog().debug({ sessionId, trigger }, 'session_already_deactivated');
    } else {
      throw error;
    }
  }
}

async function handleWorktreeCommand(
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

  const mainPath = codebase.default_cwd;
  const subcommand = args[0];

  switch (subcommand) {
    case 'create': {
      const branchName = args[1];
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
        // Use isolation provider for worktree creation
        const provider = getIsolationProvider();
        const env = await provider.create({
          codebaseId: conversation.codebase_id,
          canonicalRepoPath: toRepoPath(mainPath),
          workflowType: 'task',
          identifier: branchName,
          description: `Manual worktree: ${branchName}`,
        });

        // Add to git safe.directory
        await execFileAsync('git', [
          'config',
          '--global',
          '--add',
          'safe.directory',
          env.workingPath,
        ]);

        // Create database record for isolation environment
        const dbEnv = await isolationEnvDb.create({
          codebase_id: conversation.codebase_id,
          workflow_type: 'task',
          workflow_id: `task-${branchName}`,
          provider: 'worktree',
          working_path: env.workingPath,
          branch_name: env.branchName ?? branchName,
          created_by_platform: conversation.platform_type,
        });

        // Update conversation with isolation info (use database UUID)
        await db.updateConversation(conversation.id, {
          isolation_env_id: dbEnv.id,
          cwd: env.workingPath,
        });

        // NOTE: Do NOT deactivate session - preserve AI context per plan

        const shortPath = shortenPath(env.workingPath, mainPath);
        return {
          success: true,
          message: `Worktree created!\n\nBranch: ${env.branchName ?? branchName}\nPath: ${shortPath}\n\nThis conversation now works in isolation.\nRun dependency install if needed (e.g., bun install).`,
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
        if (err.message.includes('already exists')) {
          return {
            success: false,
            message: `Branch '${branchName}' already exists. Use a different name.`,
          };
        }
        return { success: false, message: `Failed to create worktree: ${err.message}` };
      }
    }

    case 'list': {
      try {
        const { stdout } = await execFileAsync('git', ['-C', mainPath, 'worktree', 'list']);

        // Resolve the current worktree's working path from the DB (isolation_env_id is a UUID)
        let currentWorktreePath: string | null = null;
        if (conversation.isolation_env_id) {
          const currentEnv = await isolationEnvDb.getById(conversation.isolation_env_id);
          currentWorktreePath = currentEnv?.working_path ?? null;
        }

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

          const isActive = currentWorktreePath && fullPath === currentWorktreePath;
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

    case 'remove': {
      const isolationEnvId = conversation.isolation_env_id;
      if (!isolationEnvId) {
        return { success: false, message: 'This conversation is not using a worktree.' };
      }

      // Look up the isolation environment to get the working path
      const isolationEnv = await isolationEnvDb.getById(isolationEnvId);
      if (!isolationEnv) {
        return { success: false, message: 'Isolation environment not found in database.' };
      }

      const forceFlag = args[1] === '--force';

      try {
        // Use isolation provider for removal (pass the working path, not UUID)
        const provider = getIsolationProvider();
        await provider.destroy(isolationEnv.working_path, { force: forceFlag });

        // Update database record status
        await isolationEnvDb.updateStatus(isolationEnvId, 'destroyed');

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
        if (err.message.includes('untracked files') || err.message.includes('modified')) {
          return {
            success: false,
            message:
              'Worktree has uncommitted changes.\n\nCommit your work first, or use `/worktree remove --force` to discard.',
          };
        }
        return { success: false, message: `Failed to remove worktree: ${err.message}` };
      }
    }

    case 'orphans': {
      try {
        // Show all worktrees from git perspective (source of truth)
        // Useful for discovering skill-created worktrees or stale entries
        const gitWorktrees = await listWorktrees(toRepoPath(mainPath));

        if (gitWorktrees.length <= 1) {
          return {
            success: true,
            message:
              'No worktrees found (only main repo).\n\nUse `/worktree create <branch>` to create one.',
          };
        }

        // Resolve working path from UUID for current marker
        let currentWorktreePath: string | null = null;
        if (conversation.isolation_env_id) {
          const currentEnv = await isolationEnvDb.getById(conversation.isolation_env_id);
          currentWorktreePath = currentEnv?.working_path ?? null;
        }

        let msg = 'All worktrees (from git):\n\n';
        for (const wt of gitWorktrees) {
          const isMainRepo = wt.path === mainPath;
          if (isMainRepo) continue;

          const shortPath = shortenPath(wt.path, mainPath);
          const isCurrent = currentWorktreePath && wt.path === currentWorktreePath;
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

    case 'cleanup': {
      const cleanupType = args[1];

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
          result = await cleanupMergedWorktrees(conversation.codebase_id, mainPath);
        } else {
          result = await cleanupStaleWorktrees(conversation.codebase_id, mainPath);
        }

        let msg = '';

        if (result.removed.length > 0) {
          msg += `Cleaned up ${String(result.removed.length)} ${cleanupType} worktree(s):\n`;
          for (const branch of result.removed) {
            msg += `  • ${branch}\n`;
          }
        } else {
          msg += `No ${cleanupType} worktrees to clean up.\n`;
        }

        if (result.skipped.length > 0) {
          msg += `\nSkipped ${String(result.skipped.length)} (protected):\n`;
          for (const { branchName, reason } of result.skipped) {
            msg += `  • ${branchName} (${reason})\n`;
          }
        }

        // Show updated count
        const count = await isolationEnvDb.countActiveByCodebase(conversation.codebase_id);
        msg += `\nActive worktrees: ${String(count)}`;

        return { success: true, message: msg.trim() };
      } catch (error) {
        const err = error as Error;
        getLog().error(
          { err, cleanupType, codebaseId: conversation.codebase_id },
          'cmd.worktree_cleanup_failed'
        );
        return { success: false, message: `Failed to cleanup: ${err.message}` };
      }
    }

    default:
      return {
        success: false,
        message:
          'Usage:\n  /worktree create <branch>\n  /worktree list\n  /worktree remove [--force]\n  /worktree cleanup merged|stale\n  /worktree orphans',
      };
  }
}

async function handleWorkflowCommand(
  conversation: Conversation,
  args: string[]
): Promise<CommandResult> {
  const subcommand = args[0];

  // Workflow commands work with or without a project context
  const codebase = conversation.codebase_id
    ? await codebaseDb.getCodebase(conversation.codebase_id)
    : null;

  const workflowCwd = codebase
    ? (conversation.cwd ?? codebase.default_cwd)
    : getArchonWorkspacesPath();

  switch (subcommand) {
    case 'list':
    case 'ls': {
      let workflowEntries: readonly WorkflowWithSource[];
      let errors: readonly WorkflowLoadError[];
      try {
        const result = await discoverWorkflowsWithConfig(workflowCwd, loadConfig);
        workflowEntries = result.workflows;
        errors = result.errors;
      } catch (error) {
        const err = error as Error;
        getLog().error({ err, cwd: workflowCwd }, 'cmd.workflow_list_failed');
        return {
          success: false,
          message: `Failed to load workflows: ${err.message}\n\nCheck .archon/workflows/ for YAML syntax issues.`,
        };
      }

      if (workflowEntries.length === 0 && errors.length === 0) {
        return {
          success: true,
          message: 'No workflows found.\n\nCreate workflows in `.archon/workflows/` as YAML files.',
        };
      }

      let msg = '';

      if (workflowEntries.length > 0) {
        msg += 'Available Workflows:\n\n';
        for (const { workflow: w } of workflowEntries) {
          const modeInfo = `DAG: ${String(w.nodes.length)} nodes`;
          msg += `**\`${w.name}\`**\n  ${w.description}\n  ${modeInfo}\n\n`;
        }
      }

      if (errors.length > 0) {
        const displayErrors = errors.slice(0, 10);
        msg += `\n---\n\n**${String(errors.length)} workflow(s) failed to load:**\n\n`;
        for (const e of displayErrors) {
          msg += `- \`${e.filename}\`: ${e.error}\n`;
        }
        if (errors.length > 10) {
          msg += `\n...and ${String(errors.length - 10)} more\n`;
        }
      }

      return { success: true, message: msg };
    }

    case 'reload': {
      try {
        const { workflows: reloadedWorkflows, errors: reloadErrors } =
          await discoverWorkflowsWithConfig(workflowCwd, loadConfig);
        let msg = `Discovered ${String(reloadedWorkflows.length)} workflow(s).`;
        if (reloadErrors.length > 0) {
          msg += `\n\n**${String(reloadErrors.length)} failed to load:**\n`;
          for (const e of reloadErrors) {
            msg += `- \`${e.filename}\`: ${e.error}\n`;
          }
        }
        return { success: true, message: msg };
      } catch (error) {
        const err = error as Error;
        getLog().error({ err, cwd: workflowCwd }, 'cmd.workflow_reload_failed');
        return {
          success: false,
          message: `Failed to reload workflows: ${err.message}\n\nCheck .archon/workflows/ for YAML syntax issues.`,
        };
      }
    }

    case 'cancel': {
      try {
        const activeWorkflow = await workflowDb.getActiveWorkflowRun(conversation.id);
        if (!activeWorkflow) {
          return {
            success: true,
            message: 'No active workflow to cancel.',
          };
        }

        await workflowDb.cancelWorkflowRun(activeWorkflow.id);
        return {
          success: true,
          message: `Cancelled workflow: \`${activeWorkflow.workflow_name}\``,
        };
      } catch (error) {
        const err = error as Error;
        getLog().error({ err, conversationId: conversation.id }, 'cmd.workflow_cancel_failed');
        return { success: false, message: 'Failed to cancel workflow. Please try again.' };
      }
    }

    case 'status': {
      try {
        const { runs: activeRuns } = await getWorkflowStatus();

        if (activeRuns.length === 0) {
          return { success: true, message: 'No active workflows.' };
        }

        let msg = `**Active Workflows (${String(activeRuns.length)})**\n\n`;
        for (const run of activeRuns) {
          msg += `**\`${run.workflow_name}\`** (${run.status})\n`;
          msg += `  ID: ${run.id}\n`;
          msg += `  Path: ${run.working_path ?? '(unknown)'}\n`;
          msg += `  Started: ${new Date(run.started_at).toISOString()}\n\n`;
        }

        const hasRunning = activeRuns.some(r => r.status === 'running');
        const hasPaused = activeRuns.some(r => r.status === 'paused');
        if (hasRunning) msg += 'Use `/workflow cancel` to stop a running workflow.';
        if (hasPaused)
          msg +=
            '\nUse `/workflow approve <id>` or `/workflow reject <id> <reason>` for paused runs.';
        return { success: true, message: msg.trim() };
      } catch (error) {
        const err = error as Error;
        getLog().error({ err, conversationId: conversation.id }, 'cmd.workflow_status_failed');
        return {
          success: false,
          message: 'Failed to retrieve workflow status. Please try again.',
        };
      }
    }

    case 'resume': {
      const runId = args[1];
      if (!runId) {
        return {
          success: false,
          message:
            'Usage: /workflow resume <id>\n\nResumes a failed workflow from completed nodes.',
        };
      }
      try {
        const run = await resumeWorkflow(runId);
        const pathInfo = run.working_path ? `\nPath: \`${run.working_path}\`` : '';
        return {
          success: true,
          message: `Workflow run \`${run.workflow_name}\` (${runId}) is ready to resume.${pathInfo}\nRun the same workflow again to auto-resume from completed nodes.`,
        };
      } catch (error) {
        const err = error as Error;
        getLog().error({ err, runId }, 'cmd.workflow_resume_failed');
        return { success: false, message: `Failed to resume workflow run: ${err.message}` };
      }
    }

    case 'abandon': {
      const runId = args[1];
      if (!runId) {
        return {
          success: false,
          message: 'Usage: /workflow abandon <id>\n\nUse /workflow status to see active runs.',
        };
      }
      try {
        const run = await abandonWorkflow(runId);
        return {
          success: true,
          message: `Abandoned workflow run \`${run.workflow_name}\` (${runId})`,
        };
      } catch (error) {
        const err = error as Error;
        getLog().error({ err, runId }, 'cmd.workflow_abandon_failed');
        return { success: false, message: `Failed to abandon workflow run: ${err.message}` };
      }
    }

    case 'approve': {
      const runId = args[1];
      if (!runId) {
        return {
          success: false,
          message: 'Usage: /workflow approve <id> [comment]\n\nApproves a paused workflow run.',
        };
      }
      const comment = args.slice(2).join(' ') || 'Approved';
      try {
        const result = await approveWorkflow(runId, comment);
        const pathInfo = result.workingPath ? `\nPath: \`${result.workingPath}\`` : '';
        const msg =
          result.type === 'interactive_loop'
            ? `Workflow \`${result.workflowName}\` loop input received.${pathInfo}\nType your next message in this conversation to resume the workflow.`
            : `Workflow \`${result.workflowName}\` approved.${pathInfo}\nType your response in this conversation to resume the workflow.`;
        return { success: true, message: msg };
      } catch (error) {
        const err = error as Error;
        getLog().error({ err, runId }, 'cmd.workflow_approve_failed');
        return { success: false, message: `Failed to approve workflow run: ${err.message}` };
      }
    }

    case 'reject': {
      const runId = args[1];
      if (!runId) {
        return {
          success: false,
          message: 'Usage: /workflow reject <id> [reason]\n\nRejects a paused workflow run.',
        };
      }
      const reason = args.slice(2).join(' ') || 'Rejected';
      try {
        const result = await rejectWorkflow(runId, reason);
        if (result.cancelled) {
          const suffix = result.maxAttemptsReached ? ' (max attempts reached)' : '';
          return {
            success: true,
            message: `Workflow \`${result.workflowName}\` rejected and cancelled${suffix}.`,
          };
        }
        return {
          success: true,
          message:
            `Workflow \`${result.workflowName}\` rejected. Reworking with your feedback...\n` +
            'Type your next message in this conversation to resume the workflow.',
        };
      } catch (error) {
        const err = error as Error;
        getLog().error({ err, runId }, 'cmd.workflow_reject_failed');
        return { success: false, message: `Failed to reject workflow run: ${err.message}` };
      }
    }

    case 'run': {
      // Directly invoke a workflow by name (bypasses AI router)
      const workflowName = args[1];
      const workflowArgs = args.slice(2).join(' ');

      if (!workflowName) {
        return {
          success: false,
          message:
            'Usage: /workflow run <name> [args]\n\nUse /workflow list to see available workflows.',
        };
      }

      getLog().debug(
        { workflowName, args: workflowArgs, cwd: workflowCwd },
        'cmd.workflow_run_invoked'
      );

      // Discover workflows with error handling
      let workflowEntries: readonly WorkflowWithSource[];
      let loadErrors: readonly WorkflowLoadError[];
      try {
        const result = await discoverWorkflowsWithConfig(workflowCwd, loadConfig);
        workflowEntries = result.workflows;
        loadErrors = result.errors;
      } catch (error) {
        const err = error as Error;
        getLog().error({ err, cwd: workflowCwd }, 'cmd.workflow_discovery_failed');
        return {
          success: false,
          message: `Failed to load workflows: ${err.message}\n\nCheck .archon/workflows/ for YAML syntax issues.`,
        };
      }

      const workflows = workflowEntries.map(ws => ws.workflow);
      getLog().debug(
        {
          count: workflows.length,
          names: workflows.map(w => w.name),
          searchingFor: workflowName,
        },
        'cmd.workflows_discovered'
      );

      let workflow: WorkflowDefinition | undefined;
      try {
        workflow = resolveWorkflowName(workflowName, workflows);
      } catch (err) {
        // Ambiguous match — surface the candidates to the user
        getLog().warn(
          { requested: workflowName, error: (err as Error).message },
          'cmd.workflow_resolve_ambiguous'
        );
        return {
          success: false,
          message: (err as Error).message,
        };
      }

      if (!workflow) {
        // Check if the requested workflow had a load error
        const loadError = loadErrors.find(
          e =>
            e.filename.replace(/\.ya?ml$/, '') === workflowName ||
            e.filename === `${workflowName}.yaml` ||
            e.filename === `${workflowName}.yml`
        );
        if (loadError) {
          return {
            success: false,
            message: `Workflow \`${workflowName}\` failed to load: ${loadError.error}\n\nFix the YAML file and try again.`,
          };
        }
        getLog().warn(
          { requested: workflowName, available: workflows.map(w => w.name) },
          'cmd.workflow_not_found'
        );
        return {
          success: false,
          message: `Workflow \`${workflowName}\` not found.\n\nUse /workflow list to see available workflows.`,
        };
      }

      getLog().info({ workflow: workflow.name, args: workflowArgs }, 'cmd.workflow_starting');

      // Return special result that triggers workflow execution in orchestrator
      return {
        success: true,
        message: `Starting workflow: \`${workflow.name}\``,
        workflow: {
          definition: workflow,
          args: workflowArgs,
        },
      };
    }

    default:
      return {
        success: false,
        message:
          'Usage:\n  /workflow list - Show available workflows\n  /workflow reload - Reload workflow definitions\n  /workflow status - Show all active workflows\n  /workflow cancel - Cancel running workflow\n  /workflow resume <id> - Resume a failed run\n  /workflow abandon <id> - Discard a failed run\n  /workflow approve <id> [comment] - Approve a paused run\n  /workflow reject <id> [reason] - Reject a paused run\n  /workflow run <name> [args] - Run a workflow directly',
      };
  }
}

export async function handleCommand(
  conversation: Conversation,
  message: string
): Promise<CommandResult> {
  const { command, args } = parseCommand(message);

  switch (command) {
    case 'help':
      return {
        success: true,
        message: `## Archon Orchestrator

Talk naturally — the orchestrator routes your requests to the right workflow and project automatically.

### Commands

**Chat**
- Just type your message — the orchestrator handles routing
- Mention a project by name and the orchestrator will use it
- Ask to "run [workflow] on [project]" for explicit invocation

**Workflows**
- \`/workflow list\` — List available workflows
- \`/workflow run <name> [message]\` — Run a workflow explicitly
- \`/workflow status\` — Show all active workflows
- \`/workflow cancel\` — Cancel the active workflow
- \`/workflow resume <id>\` — Resume a failed run
- \`/workflow abandon <id>\` — Discard a failed run
- \`/workflow approve <id>\` — Approve a paused run
- \`/workflow reject <id>\` — Reject a paused run

**Projects**
- \`/register-project <name> <path>\` — Register a local project
- \`/update-project <name> <new-path>\` — Update a project's path
- \`/remove-project <name>\` — Remove a registered project

**Session**
- \`/status\` — Show current session and project info
- \`/reset\` — Clear conversation and start fresh
- \`/help\` — Show this help message

### Tips
- You don't need to select a project first — just describe what you want
- The orchestrator knows all your registered projects and available workflows
- For project setup, ask the orchestrator: "How do I add a new project?"`,
      };

    case 'status': {
      let msg = `## Orchestrator Status\n\n**Platform**: ${conversation.platform_type}\n**AI Assistant**: ${conversation.ai_assistant_type}`;

      // Show all registered projects
      const allCodebases = await codebaseDb.listCodebases();
      if (allCodebases.length > 0) {
        msg += `\n\n## Registered Projects (${String(allCodebases.length)})\n`;
        for (const cb of allCodebases) {
          const urlSuffix = cb.repository_url
            ? ` (${cb.repository_url.replace(/.*github\.com\//, '')})`
            : '';
          msg += `- ${cb.name}${urlSuffix}\n`;
        }
      } else {
        msg += '\n\n## Registered Projects\nNone — ask the orchestrator to add a project.';
      }

      // Show conversation context
      const codebase = conversation.codebase_id
        ? await codebaseDb.getCodebase(conversation.codebase_id)
        : null;

      if (codebase?.name) {
        const repoContext = await formatRepoContext(codebase, conversation.isolation_env_id);
        msg += `\n\n## Conversation Context\n- Project: ${repoContext}`;
        if (conversation.cwd) {
          msg += `\n- Working Directory: ${conversation.cwd}`;
        }
      } else {
        msg += '\n\n## Conversation Context\n- Project: None — orchestrator will route as needed';
      }

      const session = await sessionDb.getActiveSession(conversation.id);
      if (session?.id) {
        msg += `\nActive Session: ${session.id.slice(0, 8)}...`;
      }

      // Add workflow status
      try {
        const activeWorkflow = await workflowDb.getActiveWorkflowRun(conversation.id);
        if (activeWorkflow) {
          const timing = calculateWorkflowTiming(activeWorkflow);

          if (timing.isValid) {
            msg += `\n\nActive Workflow: \`${activeWorkflow.workflow_name}\``;
            msg += `\n  ID: ${activeWorkflow.id.slice(0, 8)}`;
            msg += `\n  Duration: ${timing.durationMin}m ${timing.durationSec}s`;
            msg += `\n  Last activity: ${timing.lastActivitySec}s ago`;
            msg += '\n  Cancel: `/workflow cancel`';
          } else {
            // Graceful fallback for corrupted timing data
            msg += `\n\nActive Workflow: \`${activeWorkflow.workflow_name}\` (timing unavailable)`;
            msg += '\n  Cancel: `/workflow cancel`';
          }
        }
      } catch (error) {
        // Don't fail status if workflow query fails
        const err = error as Error;
        getLog().error(
          { err, conversationId: conversation.id },
          'cmd.workflow_status_query_failed'
        );
      }

      // Add worktree breakdown if codebase is configured
      if (codebase) {
        try {
          const breakdown = await getWorktreeStatusBreakdown(codebase.id, codebase.default_cwd);
          msg += `\n\nWorktrees: ${String(breakdown.total)} active`;
          if (breakdown.merged > 0 || breakdown.stale > 0) {
            if (breakdown.merged > 0) {
              msg += `\n  • ${String(breakdown.merged)} merged (can auto-remove)`;
            }
            if (breakdown.stale > 0) {
              msg += `\n  • ${String(breakdown.stale)} stale (14+ days inactive)`;
            }
            msg += `\n  • ${String(breakdown.active)} active`;
          }
        } catch (error) {
          // Don't fail status if breakdown fails
          const err = error as Error;
          getLog().error({ err, codebaseId: codebase.id }, 'cmd.worktree_breakdown_failed');
        }
      }

      return { success: true, message: msg };
    }

    case 'commands': {
      if (!conversation.codebase_id) {
        return { success: false, message: 'No codebase configured.' };
      }

      const commands = await codebaseDb.getCodebaseCommands(conversation.codebase_id);

      if (!Object.keys(commands).length) {
        return {
          success: true,
          message: 'No commands registered.\n\nAdd .md files to .archon/commands/ in your project.',
        };
      }

      let msg = 'Registered Commands:\n\n';
      for (const [name, def] of Object.entries(commands)) {
        msg += `${name} - ${def.path}\n`;
      }
      return { success: true, message: msg };
    }

    case 'reset': {
      const session = await sessionDb.getActiveSession(conversation.id);
      if (session) {
        await safeDeactivateSession(session.id, 'reset');
        return {
          success: true,
          message:
            'Session cleared. Starting fresh on next message.\n\nCodebase configuration preserved.',
        };
      }
      return {
        success: true,
        message: 'No active session to reset.',
      };
    }

    case 'worktree':
      return handleWorktreeCommand(conversation, args);

    case 'workflow':
      return handleWorkflowCommand(conversation, args);

    case 'init': {
      // Create .archon structure in current repo
      if (!conversation.cwd) {
        return {
          success: false,
          message: 'No working directory set. Register a project first with /register-project.',
        };
      }

      const archonDir = join(conversation.cwd, '.archon');
      const commandsDir = join(archonDir, 'commands');
      const configPath = join(archonDir, 'config.yaml');

      try {
        // Check if .archon already exists
        try {
          await access(archonDir);
          return {
            success: false,
            message: '.archon directory already exists. Nothing to do.',
          };
        } catch {
          // Directory doesn't exist, we can create it
        }

        // Create directories
        await import('fs/promises').then(fs => fs.mkdir(commandsDir, { recursive: true }));

        // Create default config.yaml
        const defaultConfig = `# Archon repository configuration
# See: https://github.com/coleam00/Archon

# AI assistant preference (optional - overrides global default)
# assistant: claude

# Commands configuration (optional)
# commands:
#   folder: .archon/commands
#   autoLoad: true
`;
        await writeFile(configPath, defaultConfig);

        // Create example command
        const exampleCommand = join(commandsDir, 'example.md');
        const exampleContent = `---
description: Example command
---
# Example Command

This is an example command.

Arguments:
- $1 - First positional argument
- $ARGUMENTS - All arguments as string

Task: $ARGUMENTS
`;
        await writeFile(exampleCommand, exampleContent);

        return {
          success: true,
          message: `Created .archon structure:
  .archon/
  ├── config.yaml
  └── commands/
      └── example.md

Commands are auto-discovered from .archon/commands/ — no registration needed.`,
        };
      } catch (error) {
        const err = error as Error;
        getLog().error({ err, command: 'init' }, 'cmd.init_failed');
        return { success: false, message: `Failed to initialize: ${err.message}` };
      }
    }

    default:
      return {
        success: false,
        message: `Unknown command: /${command}\n\nType /help to see available commands.`,
      };
  }
}
