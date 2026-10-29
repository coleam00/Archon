import { listChildRepos, execFileAsync } from '@archon/git';
import { spellWorkflowCommand, type WorkflowCommandSurface } from '@archon/workflows/deps';
import type { Codebase, CommandResult, Conversation } from '../../types';
import * as codebaseDb from '../../db/codebases';
import { sqlState } from '../../db/sql-state';
import * as sessionDb from '../../db/sessions';
import * as isolationEnvDb from '../../db/isolation-environments';
import { getActiveChatWorkflowRun } from './workflow-runs';
import { getWorktreeStatusBreakdown } from '../../services/cleanup-service';
import { statusDiagnostic } from '../../services/cleanup/status-diagnostic';
import { getLog } from './log';

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

  if (codebase.kind === 'folder') {
    return `${codebase.name} (folder — runs in place)`;
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

/** `/status`: the registered projects, this conversation's context, its active run and worktrees. */
export async function handleStatusCommand(
  conversation: Conversation,
  surface: WorkflowCommandSurface
): Promise<CommandResult> {
  let msg = `## Orchestrator Status\n\n**Platform**: ${conversation.platform_type}\n**AI Assistant**: ${conversation.ai_assistant_type}`;
  msg += await registeredProjectsSection();

  // Show conversation context
  const codebase = conversation.codebase_id
    ? await codebaseDb.getCodebase(conversation.codebase_id)
    : null;
  msg += await conversationContextSection(conversation, codebase);

  const session = await sessionDb.getActiveSession(conversation.id);
  if (session?.id) {
    msg += `\nActive Session: ${session.id.slice(0, 8)}...`;
  }

  msg += await activeWorkflowSection(conversation, surface);

  // Add worktree breakdown if codebase is configured. Folder projects run in
  // place and have no worktrees — skip the breakdown entirely.
  if (codebase && codebase.kind !== 'folder') msg += await worktreeSection(codebase);

  return { success: true, message: msg };
}

function repositoryIdentity(remote: string): string {
  const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(remote);
  try {
    const url = new URL(remote.includes('://') || !scp ? remote : `ssh://${scp[1]}/${scp[2]}`);
    if (url.protocol === 'file:') return 'local repository';
    return url.host || 'repository identity unavailable';
  } catch {
    return remote.startsWith('/') ? 'local repository' : 'repository identity unavailable';
  }
}

async function registeredProjectsSection(): Promise<string> {
  const allCodebases = await codebaseDb.listCodebases();
  if (allCodebases.length === 0)
    return '\n\n## Registered Projects\nNone — ask the orchestrator to add a project.';
  let msg = `\n\n## Registered Projects (${String(allCodebases.length)})\n`;
  for (const cb of allCodebases) {
    const urlSuffix = cb.repository_url ? ` (${repositoryIdentity(cb.repository_url)})` : '';
    msg += `- ${cb.name}${urlSuffix}\n`;
  }
  return msg;
}

async function conversationContextSection(
  conversation: Conversation,
  codebase: Codebase | null
): Promise<string> {
  if (!codebase?.name)
    return '\n\n## Conversation Context\n- Project: None — orchestrator will route as needed';
  const repoContext = await formatRepoContext(codebase, conversation.isolation_env_id);
  // conversation.cwd is an explicit runtime override (set by worktree
  // create/remove); when unset, the registered project root is the
  // effective working directory. Same fallback as the /workflow commands.
  const effectiveCwd = conversation.cwd ?? codebase.default_cwd;
  let msg = `\n\n## Conversation Context\n- Project: ${repoContext}`;
  msg += `\n- Working Directory: ${effectiveCwd}`;
  // For a folder project, surface the git repos contained under its root.
  if (codebase.kind === 'folder') {
    const childRepos = await listChildRepos(codebase.default_cwd);
    if (childRepos.length > 0) {
      msg += `\n- ${formatChildRepos(childRepos)}`;
    }
  }
  return msg;
}

async function activeWorkflowSection(
  conversation: Conversation,
  surface: WorkflowCommandSurface
): Promise<string> {
  const cancel = spellWorkflowCommand(surface, 'cancel');
  let msg = '';
  try {
    const activeWorkflow = await getActiveChatWorkflowRun(conversation);
    if (activeWorkflow) {
      const timing = calculateWorkflowTiming(activeWorkflow);

      if (timing.isValid) {
        msg += `\n\nActive Workflow: \`${activeWorkflow.workflow_name}\``;
        msg += `\n  ID: ${activeWorkflow.id.slice(0, 8)}`;
        msg += `\n  Duration: ${timing.durationMin}m ${timing.durationSec}s`;
        msg += `\n  Last activity: ${timing.lastActivitySec}s ago`;
        msg += `\n  Cancel: \`${cancel}\``;
      } else {
        // Graceful fallback for corrupted timing data
        msg += `\n\nActive Workflow: \`${activeWorkflow.workflow_name}\` (timing unavailable)`;
        msg += `\n  Cancel: \`${cancel}\``;
      }
    }
  } catch (error) {
    // Don't fail status if workflow query fails
    const err = error as Error;
    getLog().error({ err, conversationId: conversation.id }, 'cmd.workflow_status_query_failed');
  }
  return msg;
}

async function worktreeSection(codebase: Codebase): Promise<string> {
  let msg = '';
  try {
    const breakdown = await getWorktreeStatusBreakdown(codebase.id, codebase.default_cwd);
    msg += `\n\nWorktrees: ${String(breakdown.total)} total`;
    if (breakdown.classificationUnavailable) {
      return `${msg}\n  • Merge/stale classification unavailable (base ref resolution failed: ${breakdown.classificationUnavailable.reason})`;
    }
    if (breakdown.merged > 0 || breakdown.stale > 0 || breakdown.inspectionFailedEnvs.length > 0) {
      if (breakdown.merged > 0) {
        msg += `\n  • ${String(breakdown.merged)} merged (can auto-remove)`;
      }
      if (breakdown.stale > 0) {
        msg += `\n  • ${String(breakdown.stale)} stale (14+ days inactive)`;
      }
      msg += `\n  • ${String(breakdown.active)} active`;
    }
    for (const env of breakdown.inspectionFailedEnvs) {
      msg += `\n  • ${env.branchName}: merge inspection failed (${env.errors.join('; ')})`;
    }
    for (const env of breakdown.activeEnvs) {
      if (env.reason) msg += `\n  • ${env.branchName}: ${env.reason}`;
    }
  } catch (error) {
    getLog().error(
      { reason: statusDiagnostic(error), code: sqlState(error), codebaseId: codebase.id },
      'cmd.worktree_breakdown_failed'
    );
    return '\n\nWorktrees: inventory unavailable (count unknown)';
  }
  return msg;
}
