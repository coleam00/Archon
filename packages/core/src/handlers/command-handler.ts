/**
 * Command handler for slash commands
 * Handles deterministic operations without AI
 */
import { writeFile, access } from 'fs/promises';
import { join, relative } from 'path';
import {
  type Conversation,
  type CommandResult,
  type Codebase,
  ConversationNotFoundError,
} from '../types';
import * as db from '../db/conversations';
import * as codebaseDb from '../db/codebases';
import * as sessionDb from '../db/sessions';
import { listWorktrees, execFileAsync, listChildRepos, toRepoPath } from '@archon/git';
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
import { resolveContinuationWorkflow } from '@archon/workflows/executor';
import { createWorkflowDeps } from '../workflows/store-adapter';
import type {
  WorkflowWithSource,
  WorkflowLoadError,
  WorkflowDefinition,
} from '@archon/workflows/schemas/workflow';
import { isContainerRun } from '@archon/workflows/schemas/workflow-run';
import * as workflowDb from '../db/workflows';
import {
  approveWorkflow,
  rejectWorkflow,
  respondToWorkflow,
  getWorkflowStatus,
  resumeWorkflow,
  abandonWorkflow,
  abandonResumableRunsForConversation,
  resetWorkflowNodeSessions,
} from '../operations/workflow-operations';
import { safeDeactivateSession } from '../state/session-transitions';
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
 * Format a folder project's contained git repos for status display.
 * Truncates the visible list at 10 and appends a "(+N more)" count.
 */
function formatChildRepos(childRepos: string[]): string {
  const MAX_SHOWN = 10;
  const shown = childRepos.slice(0, MAX_SHOWN);
  const remaining = childRepos.length - shown.length;
  const suffix = remaining > 0 ? `, … (+${String(remaining)} more)` : '';
  return `Contains ${String(childRepos.length)} git repo${childRepos.length === 1 ? '' : 's'}: ${shown.join(', ')}${suffix}`;
}

/**
 * Format repository context for user-facing display.
 * Shows "owner/repo @ branch" instead of filesystem paths.
 *
 * @returns Formatted context string. Never throws - falls back gracefully on errors.
 */
async function formatRepoContext(
  codebase: { name: string; default_cwd: string; kind?: 'repo' | 'folder' } | null,
  isolationEnvId: string | null
): Promise<string> {
  if (!codebase) {
    return 'No codebase configured';
  }

  // Folder projects have no git — show an honest "no git" label instead of a
  // branch (a folder root may not be a repo at all).
  if (codebase.kind === 'folder') {
    return `${codebase.name} (folder — no git)`;
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
  const matches: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;
  let hasToken = false;

  for (const char of text.trim()) {
    if (quote) {
      hasToken = true;
      if (escaping) {
        current += char;
        escaping = false;
      } else if (char === '\\') {
        escaping = true;
      } else if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (/\s/.test(char)) {
      if (hasToken) {
        matches.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      hasToken = true;
      continue;
    }

    current += char;
    hasToken = true;
  }

  if (escaping) {
    current += '\\';
  }
  if (hasToken) {
    matches.push(current);
  }

  if (matches.length === 0 || !matches[0]) {
    return { command: '', args: [] };
  }

  if (!matches[0].startsWith('/')) {
    return { command: '', args: [] };
  }

  const command = matches[0].substring(1); // Remove leading '/'
  const args = matches.slice(1);

  return { command, args };
}

function findWorkflowLoadError(
  loadErrors: readonly WorkflowLoadError[],
  workflowName: string
): WorkflowLoadError | undefined {
  // Stripping the .yaml/.yml extension already covers the exact-filename cases.
  return loadErrors.find(error => error.filename.replace(/\.ya?ml$/, '') === workflowName);
}

/**
 * Resolve everything the orchestrator needs to continue a resumable run: the run
 * itself plus its workflow definition, packaged as the `workflow` payload of a
 * `CommandResult`. Returns a user-facing failure message instead when the run is
 * not resumable or its workflow can no longer be loaded.
 *
 * Shared by `/workflow resume`, `/workflow approve` and `/workflow reject`
 * (#2565): a gate decision that does not continue the run leaves it stranded, so
 * all three resolve the same continuation the same way. Also reused by the HTTP
 * `resumeRunHeadless` fallback (packages/server) for runs with no parent
 * conversation to dispatch a chat message through (#2008).
 */
export async function resolveRunContinuation(
  runId: string,
  workflowCwd: string
): Promise<
  | { ok: true; workflow: NonNullable<CommandResult['workflow']>; workflowName: string }
  // `resumeHint` replaces the caller's default "retry with /workflow resume"
  // line when that is the wrong next step.
  | { ok: false; message: string; resumeHint?: string }
> {
  const run = await resumeWorkflow(runId);
  // A container run can only be resumed where the container can be rewired, so
  // handing this one back for a chat dispatch would fail the run to say what we
  // can say here for free (#2565).
  if (isContainerRun(run)) {
    return {
      ok: false,
      message: 'it executed inside an isolation container, which chat cannot rewire.',
      resumeHint: `Finish it with \`archon workflow resume ${runId}\` from the CLI in the same project.`,
    };
  }
  // The graph this run FROZE, not whatever the target holds now. Without this the run
  // resumes into a possibly-edited DAG while the executor still feeds it commands and
  // scripts from the old capture — a graph from one moment against resources from
  // another. Returns undefined only for a run predating capture, which falls through to
  // live discovery below exactly as before.
  try {
    const continuation = await resolveContinuationWorkflow(createWorkflowDeps(), run, workflowCwd);
    if (continuation) {
      return {
        ok: true,
        workflowName: continuation.workflow.name,
        workflow: {
          definition: continuation.workflow,
          args: run.user_message,
          resumeRunId: run.id,
          resumeRun: run,
          // Already resolved from the run's recorded source, digest verified and
          // discovered. Forwarded so dispatch does not pay for both again.
          resolvedContinuation: continuation.workflow,
        },
      };
    }
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, runId }, 'cmd.workflow_continuation_source_failed');
    return {
      ok: false,
      message: `its recorded workflow source is unavailable: ${err.message}`,
      resumeHint: 'Start a fresh run to execute the current workflow.',
    };
  }

  let workflowEntries: readonly WorkflowWithSource[];
  let loadErrors: readonly WorkflowLoadError[];
  try {
    const result = await discoverWorkflowsWithConfig(workflowCwd, loadConfig);
    workflowEntries = result.workflows;
    loadErrors = result.errors;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, cwd: workflowCwd, runId }, 'cmd.workflow_resume_discovery_failed');
    return {
      ok: false,
      message: `Failed to load workflows: ${err.message}\n\nCheck .archon/workflows/ for YAML syntax issues.`,
    };
  }
  const workflow = resolveWorkflowName(
    run.workflow_name,
    workflowEntries.map(ws => ws.workflow)
  );
  if (!workflow) {
    const loadError = findWorkflowLoadError(loadErrors, run.workflow_name);
    if (loadError) {
      return {
        ok: false,
        message: `Workflow \`${run.workflow_name}\` failed to load: ${loadError.error}\n\nFix the YAML file and try again.`,
      };
    }
    return {
      ok: false,
      message:
        `Workflow \`${run.workflow_name}\` for run ${runId} was not found.\n\n` +
        'Use /workflow list to check available workflows.',
    };
  }
  return {
    ok: true,
    workflowName: workflow.name,
    workflow: {
      definition: workflow,
      args: run.user_message,
      resumeRunId: run.id,
      resumeRun: run,
    },
  };
}

/**
 * Attach the run continuation to an already-recorded gate decision.
 *
 * The decision is committed by the time this runs, so a continuation that cannot
 * be resolved is reported as a follow-up step, never as a failed command — saying
 * "failed" about a gate that IS resolved would send the user to re-approve a run
 * that refuses a second decision.
 */
async function withRunContinuation(
  runId: string,
  workflowCwd: string,
  headline: string,
  action: 'approve' | 'reject' | 'respond'
): Promise<CommandResult> {
  let continuation: Awaited<ReturnType<typeof resolveRunContinuation>>;
  try {
    continuation = await resolveRunContinuation(runId, workflowCwd);
  } catch (error) {
    const err = error as Error;
    getLog().warn(
      { err, errorType: err.constructor.name, runId, action },
      'cmd.workflow_gate_continuation_unresolved'
    );
    continuation = { ok: false, message: err.message };
  }
  if (!continuation.ok) {
    const hint =
      continuation.resumeHint ?? `Resume it with \`/workflow resume ${runId}\` once that is fixed.`;
    return {
      success: true,
      message: `${headline}\nThe run could not be continued automatically: ${continuation.message}\n${hint}`,
    };
  }
  return {
    success: true,
    message: `${headline}\nResuming \`${continuation.workflowName}\`...`,
    workflow: continuation.workflow,
  };
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

  // Worktrees are a git-repo concept — folder projects run in place and have no
  // worktree lifecycle. Reject clearly rather than failing deep in git.
  if (codebase.kind === 'folder') {
    return {
      success: false,
      message: `/worktree is not applicable to folder projects. "${codebase.name}" runs in place (no git worktree).`,
    };
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
        const liveRun = await isolationEnvDb.getLiveRunOwningEnv(isolationEnvId);
        if (liveRun) {
          return {
            success: false,
            message:
              `Worktree is still owned by workflow run ${liveRun.id.slice(0, 8)} ` +
              `(${liveRun.status}). Resume or abandon it before removing the worktree.`,
          };
        }

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
        for (const { workflow: w, parseWarnings } of workflowEntries) {
          const modeInfo = `DAG: ${String(w.nodes.length)} nodes`;
          msg += `**\`${w.name}\`**\n  ${w.description}\n  ${modeInfo}\n`;
          // Keys the engine silently drops (#2213). Rendered inline with the
          // workflow rather than in a trailer so the author sees which of their
          // workflows is affected without cross-referencing.
          for (const warning of parseWarnings ?? []) {
            msg += `  ⚠️ ${warning}\n`;
          }
          msg += '\n';
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
        const continuation = await resolveRunContinuation(runId, workflowCwd);
        if (!continuation.ok) {
          return { success: false, message: continuation.message };
        }
        return {
          success: true,
          message: `Resuming workflow: \`${continuation.workflowName}\``,
          workflow: continuation.workflow,
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
        const { run, cascadeFailures, blockedParentRunId } = await abandonWorkflow(runId);
        let message = `Abandoned workflow run \`${run.workflow_name}\` (${runId})`;
        if (cascadeFailures > 0) {
          message += `\n⚠️ ${String(cascadeFailures)} sub-run(s) could not be cancelled and may still be running — check /workflow status.`;
        }
        if (blockedParentRunId) {
          message += `\n⚠️ Parent run ${blockedParentRunId} was blocked on this sub-run and stays paused. Resume it to fail the node cleanly, or abandon it too.`;
        }
        return { success: true, message };
      } catch (error) {
        const err = error as Error;
        getLog().error({ err, runId }, 'cmd.workflow_abandon_failed');
        return { success: false, message: `Failed to abandon workflow run: ${err.message}` };
      }
    }

    case 'reset-sessions': {
      const workflowName = args[1];
      const nodeId = args[2];
      if (!workflowName) {
        return {
          success: false,
          message:
            'Usage: /workflow reset-sessions <workflow-name> [<node-id>]\n\nClears persisted AI session memory for this workflow in this conversation.',
        };
      }
      try {
        const { deleted } = await resetWorkflowNodeSessions({
          workflow_name: workflowName,
          scope_key: conversation.id,
          node_id: nodeId,
        });
        const nodeSuffix = nodeId ? ` node \`${nodeId}\` of` : '';
        return {
          success: true,
          message: `Cleared ${deleted} persisted session(s) for${nodeSuffix} workflow \`${workflowName}\` in this conversation.`,
        };
      } catch (error) {
        const err = error as Error;
        getLog().error({ err, workflowName, nodeId }, 'cmd.workflow_reset_sessions_failed');
        return {
          success: false,
          message: `Failed to reset workflow sessions: ${err.message}`,
        };
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
      // Pass the RAW comment through (undefined when the user typed none) —
      // approveWorkflow defaults the recorded comment internally, but "no
      // feedback" must survive so a signal-bearing interactive-loop gate
      // finalizes instead of re-running (#2074, loop_feedback_given). Mirrors
      // the HTTP route and CLI.
      const rawComment = args.slice(2).join(' ');
      const comment = rawComment.length > 0 ? rawComment : undefined;
      try {
        const result = await approveWorkflow(runId, comment);
        const pathInfo = result.workingPath ? `\nPath: \`${result.workingPath}\`` : '';
        const headline =
          result.type === 'interactive_loop'
            ? `Workflow \`${result.workflowName}\` loop input received.${pathInfo}`
            : `Workflow \`${result.workflowName}\` approved.${pathInfo}`;
        // Resolving is only half the action — continue the run too (#2565).
        // Before #2565 this told the user to "type your response to resume",
        // which relied on a natural-language branch that no longer exists.
        return await withRunContinuation(runId, workflowCwd, headline, 'approve');
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
        // Not cancelled means either a legacy on_reject rework is staged, or
        // (#2707 step 1) a new-mode gate resolved with structured output —
        // continue the run either way so the resolution actually takes effect
        // (#2565).
        return await withRunContinuation(
          runId,
          workflowCwd,
          result.newMode
            ? `Workflow \`${result.workflowName}\` rejected. Continuing...`
            : `Workflow \`${result.workflowName}\` rejected. Reworking with your feedback...`,
          'reject'
        );
      } catch (error) {
        const err = error as Error;
        getLog().error({ err, runId }, 'cmd.workflow_reject_failed');
        return { success: false, message: `Failed to reject workflow run: ${err.message}` };
      }
    }

    case 'respond': {
      // General drive verb (#2707 step 2): resolves a paused gate with any of its
      // author-declared decisions. 'approve'/'reject' behave identically to the
      // dedicated commands above — respondToWorkflow delegates those two ids to the
      // exact same approveWorkflow/rejectWorkflow functions — this handler just
      // formats whichever result shape comes back.
      const runId = args[1];
      const decision = args[2];
      if (!runId || !decision) {
        return {
          success: false,
          message:
            'Usage: /workflow respond <id> <decision> [text]\n\n' +
            "Resolves a paused gate with any of its declared decisions ('approve'/'reject' " +
            'are sugar for the dedicated /workflow approve|reject commands).',
        };
      }
      const rawText = args.slice(3).join(' ');
      // Mirrors the dedicated /workflow reject command's default: an empty reason
      // becomes 'Rejected' rather than reaching a new-mode gate's structured
      // output as ''. Only for decision === 'reject' — respond's other decisions
      // (including 'approve', which stays optional/undefined) are unaffected.
      const text = rawText.length > 0 ? rawText : decision === 'reject' ? 'Rejected' : undefined;
      try {
        const result = await respondToWorkflow(runId, decision, text);
        if ('cancelled' in result) {
          if (result.cancelled) {
            const suffix = result.maxAttemptsReached ? ' (max attempts reached)' : '';
            return {
              success: true,
              message: `Workflow \`${result.workflowName}\` rejected and cancelled${suffix}.`,
            };
          }
          return await withRunContinuation(
            runId,
            workflowCwd,
            result.newMode
              ? `Workflow \`${result.workflowName}\` rejected. Continuing...`
              : `Workflow \`${result.workflowName}\` rejected. Reworking with your feedback...`,
            'respond'
          );
        }
        const pathInfo = result.workingPath ? `\nPath: \`${result.workingPath}\`` : '';
        const headline =
          result.type === 'interactive_loop'
            ? `Workflow \`${result.workflowName}\` loop input received.${pathInfo}`
            : `Workflow \`${result.workflowName}\` responded '${decision}'.${pathInfo}`;
        return await withRunContinuation(runId, workflowCwd, headline, 'respond');
      } catch (error) {
        const err = error as Error;
        getLog().error({ err, runId, decision }, 'cmd.workflow_respond_failed');
        return { success: false, message: `Failed to respond to workflow run: ${err.message}` };
      }
    }

    case 'run': {
      // Directly invoke a workflow by name (bypasses AI router)
      const workflowName = args[1];
      const restArgs = args.slice(2);
      const force = restArgs.includes('--force');
      const workflowArgs = restArgs.filter(arg => arg !== '--force').join(' ');

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
        const loadError = findWorkflowLoadError(loadErrors, workflowName);
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

      // Recover the discovery entry the `.map()` above dropped, so the keys the
      // engine ignores reach the conversation when the run STARTS — not only
      // when the author happens to browse `/workflow list` (#2213).
      const resolvedEntry = workflowEntries.find(ws => ws.workflow === workflow);

      // Return special result that triggers workflow execution in orchestrator
      return {
        success: true,
        message: `Starting workflow: \`${workflow.name}\``,
        workflow: {
          definition: workflow,
          args: workflowArgs,
          force: force ? true : undefined,
          ...(resolvedEntry?.parseWarnings && resolvedEntry.parseWarnings.length > 0
            ? { parseWarnings: resolvedEntry.parseWarnings }
            : {}),
        },
      };
    }

    default:
      return {
        success: false,
        message:
          'Usage:\n  /workflow list - Show available workflows\n  /workflow reload - Reload workflow definitions\n  /workflow status - Show all active workflows\n  /workflow cancel - Cancel running workflow\n  /workflow resume <id> - Resume a failed run\n  /workflow abandon <id> - Discard a failed run\n  /workflow approve <id> [comment] - Approve a paused run\n  /workflow reject <id> [reason] - Reject a paused run\n  /workflow reset-sessions <name> [<node-id>] - Clear persisted AI session memory for this conversation\n  /workflow run <name> [args] - Run a workflow directly',
      };
  }
}

/**
 * Handle a slash command issued in a conversation.
 *
 * @param conversation - The active Conversation object
 * @param message - The raw slash command message text
 * @param userId - Optional authenticated user ID for access scoping
 * @returns Result object containing execution status, reply message, and optional workflow to run
 */
export async function handleCommand(
  conversation: Conversation,
  message: string,
  userId?: string
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
- \`/workflow reset-sessions <name> [<node-id>]\` — Clear persisted AI session memory for this conversation

**Projects**
- \`/register-project <name> <path>\` — Register a local project
- \`/update-project <name> <new-path>\` — Update a project's path
- \`/remove-project <name>\` — Remove a registered project
- \`/setproject <name>\` — Bind this conversation to a registered project

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

      // Show all registered projects. A missing userId falls back to the
      // unscoped global list only in solo/unauthenticated mode — when either
      // the reverse-proxy header or Better Auth (DATABASE_URL +
      // BETTER_AUTH_SECRET) is configured, fail closed with an empty list
      // instead of leaking every user's codebases.
      let allCodebases: readonly Codebase[];
      if (userId) {
        allCodebases = await codebaseDb.listCodebasesForUser(userId);
      } else if (
        process.env.ARCHON_WEB_AUTH_HEADER ||
        (process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET)
      ) {
        allCodebases = [];
      } else {
        allCodebases = await codebaseDb.listCodebases();
      }
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
      const isFolderProject = codebase?.kind === 'folder';

      if (codebase?.name) {
        const repoContext = await formatRepoContext(codebase, conversation.isolation_env_id);
        // conversation.cwd is an explicit runtime override (set by worktree
        // create/remove); when unset, the registered project root is the
        // effective working directory. Same fallback as handleWorkflowCommand.
        const effectiveCwd = conversation.cwd ?? codebase.default_cwd;
        msg += `\n\n## Conversation Context\n- Project: ${repoContext}`;
        msg += `\n- Working Directory: ${effectiveCwd}`;
        // For a folder project, surface the git repos contained under its root.
        if (isFolderProject) {
          const childRepos = await listChildRepos(codebase.default_cwd);
          if (childRepos.length > 0) {
            msg += `\n- ${formatChildRepos(childRepos)}`;
          }
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

      // Add worktree breakdown if codebase is configured. Folder projects run in
      // place and have no worktrees — skip the breakdown entirely.
      if (codebase && !isFolderProject) {
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
      // /reset is an explicit "start fresh" intent, and deactivating the AI
      // session alone does not deliver it: the execution binding (cwd +
      // isolation env) survives, and so does every resumable run, so the next
      // message can continue an old run on an old worktree instead of starting
      // over. This clears all three.
      //
      // `codebase_id` is deliberately PRESERVED. The resulting row —
      // {codebase_id: <kept>, cwd: null, isolation_env_id: null} — is byte-for-
      // byte what /setproject already writes, so this is a well-trodden state,
      // not a novel one. Detaching the project is /setproject none's job.
      let hadActiveSession = false;
      let sessionError: string | null = null;
      try {
        const session = await sessionDb.getActiveSession(conversation.id);
        hadActiveSession = session !== null;
        if (session) {
          await safeDeactivateSession(session.id, 'reset');
        }
      } catch (error) {
        const err = error as Error;
        getLog().error({ err, conversationId: conversation.id }, 'cmd.reset_clear_session_failed');
        sessionError = err.message;
      }

      // Three independent effects, three independent try blocks. Sharing the
      // run and binding effects would mean that a binding-clear failure AFTER
      // a successful abandon swallows
      // the count and reports only the failure — precisely the case where the
      // user most needs to know that N runs were already cancelled.
      let abandoned = 0;
      let abandonBlockedParentRunId: string | null = null;
      let abandonError: string | null = null;
      try {
        ({ abandoned, blockedParentRunId: abandonBlockedParentRunId } =
          await abandonResumableRunsForConversation(conversation.id));
      } catch (error) {
        const err = error as Error;
        getLog().error({ err, conversationId: conversation.id }, 'cmd.reset_abandon_failed');
        abandonError = err.message;
      }

      let bindingCleared = true;
      let bindingError: string | null = null;
      try {
        await db.updateConversation(conversation.id, { cwd: null, isolation_env_id: null });
      } catch (error) {
        const err = error as Error;
        getLog().error({ err, conversationId: conversation.id }, 'cmd.reset_clear_binding_failed');
        bindingCleared = false;
        bindingError = err.message;
      }

      const parts = [
        sessionError !== null
          ? `Could not clear the AI session: ${sessionError}`
          : hadActiveSession
            ? 'Session cleared.'
            : 'No active session.',
      ];
      parts.push(
        bindingCleared
          ? 'Cleared workspace binding (worktree + isolation env).'
          : `Could not clear the workspace binding: ${bindingError ?? 'unknown error'}`
      );
      if (abandoned > 0) parts.push(`Abandoned ${String(abandoned)} resumable run(s).`);
      if (abandonBlockedParentRunId !== null) {
        parts.push(
          `⚠️ Parent run ${abandonBlockedParentRunId} was blocked on an abandoned sub-run and stays paused. Resume it to fail the node cleanly, or abandon it too.`
        );
      }
      if (abandonError !== null) {
        parts.push(`⚠️ Could not look up resumable runs: ${abandonError}`);
      }

      const resetComplete =
        sessionError === null &&
        bindingCleared &&
        abandonError === null &&
        abandonBlockedParentRunId === null;
      parts.push(
        resetComplete
          ? 'Project attachment preserved — next message starts fresh.'
          : 'Project attachment preserved. Reset is incomplete — retry /reset before sending the next message.'
      );

      return {
        success: resetComplete,
        message: parts.join(' '),
      };
    }

    case 'worktree':
      return handleWorktreeCommand(conversation, args);

    case 'workflow':
      return handleWorkflowCommand(conversation, args);

    case 'init': {
      // Create .archon structure in the effective working directory:
      // the explicit runtime override (conversation.cwd) when set, else the
      // selected project's root. Web-created project conversations have
      // codebase_id but null cwd (issue #1993), so the fallback is what
      // makes /init work there.
      const initCodebase = conversation.codebase_id
        ? await codebaseDb.getCodebase(conversation.codebase_id)
        : null;
      const initCwd = conversation.cwd ?? initCodebase?.default_cwd;
      if (!initCwd) {
        return {
          success: false,
          message:
            'No project selected. Pick one with /setproject <name> (register it first with /register-project if needed).',
        };
      }

      const archonDir = join(initCwd, '.archon');
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
- $ARGUMENTS - The full trigger message

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
