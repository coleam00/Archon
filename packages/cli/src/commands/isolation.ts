/**
 * Isolation commands - list, cleanup, and complete worktrees
 */
import * as isolationDb from '@archon/core/db/isolation-environments';
import * as workflowDb from '@archon/core/db/workflows';
import { createLogger } from '@archon/paths';
import {
  toRepoPath,
  toBranchName,
  execFileAsync,
  hasUncommittedChanges,
  toWorktreePath,
  getDefaultBranch,
  execGhWithAuthPolicy,
} from '@archon/git';
import { getIsolationProvider } from '@archon/isolation';
import {
  removeEnvironment,
  type RemoveEnvironmentResult,
} from '@archon/core/services/cleanup-service';
import {
  listEnvironments,
  cleanupMergedEnvironments,
} from '@archon/core/operations/isolation-operations';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('cli.isolation');
  return cachedLog;
}

/**
 * List all active isolation environments
 */
export async function isolationListCommand(): Promise<void> {
  const { codebases, totalEnvironments, ghostsReconciled } = await listEnvironments();

  if (codebases.length === 0) {
    console.log('No codebases registered.');
    console.log('Use /clone or --branch to create worktrees.');
    return;
  }

  for (const codebase of codebases) {
    console.log(`\n${codebase.repositoryUrl ?? codebase.defaultCwd}:`);

    for (const env of codebase.environments) {
      const age =
        env.days_since_activity !== null
          ? `${Math.floor(env.days_since_activity)}d ago`
          : 'unknown';
      const platform = env.created_by_platform ?? 'unknown';

      console.log(`  ${env.branch_name ?? env.workflow_id}`);
      console.log(`    Path: ${env.working_path}`);
      console.log(`    Type: ${env.workflow_type} | Platform: ${platform} | Last activity: ${age}`);
    }
  }

  if (ghostsReconciled > 0) {
    console.log(
      `\nReconciled ${String(ghostsReconciled)} ghost environment(s) (missing from disk).`
    );
  }

  if (totalEnvironments === 0) {
    console.log('No active isolation environments.');
  } else {
    console.log(`\nTotal: ${String(totalEnvironments)} environment(s)`);
  }
}

/**
 * Cleanup stale isolation environments.
 * Note: This command has its own stale-finding logic (per-env worktree destroy)
 * distinct from the cleanup-service's cleanupStaleWorktrees (which uses different
 * criteria). Kept here because the display-heavy flow doesn't map cleanly to
 * the operations layer's batch-oriented API.
 */
export async function isolationCleanupCommand(daysStale = 7): Promise<void> {
  // Reconcile ghosts via the operations layer
  const { ghostsReconciled } = await listEnvironments();
  if (ghostsReconciled > 0) {
    console.log(`Reconciled ${String(ghostsReconciled)} ghost environment(s) (missing from disk).`);
  }

  console.log(`Finding environments with no activity for ${String(daysStale)}+ days...`);

  const staleEnvs = await isolationDb.findStaleEnvironments(daysStale);

  if (staleEnvs.length === 0) {
    console.log('No stale environments found.');
    return;
  }

  console.log(`Found ${String(staleEnvs.length)} stale environment(s):`);

  const provider = getIsolationProvider();
  let cleaned = 0;
  let failed = 0;

  for (const env of staleEnvs) {
    console.log(`\nCleaning: ${env.branch_name ?? env.workflow_id}`);
    console.log(`  Path: ${env.working_path}`);

    try {
      await provider.destroy(env.working_path, {
        branchName: env.branch_name ? toBranchName(env.branch_name) : undefined,
        canonicalRepoPath: toRepoPath(env.codebase_default_cwd),
      });

      await isolationDb.updateStatus(env.id, 'destroyed');
      console.log('  Status: Cleaned');
      cleaned++;
    } catch (error) {
      const err = error as Error;
      getLog().warn({ err, envId: env.id, path: env.working_path }, 'worktree_destroy_failed');
      console.error(`  Status: Failed - ${err.message}`);
      failed++;
    }
  }

  console.log(`\nCleanup complete: ${String(cleaned)} cleaned, ${String(failed)} failed`);
}

/**
 * Cleanup merged isolation environments (branches merged into main)
 * Also deletes remote branches for merged environments
 */
export async function isolationCleanupMergedCommand(
  options: { includeClosed?: boolean } = {}
): Promise<void> {
  console.log('Finding environments with branches merged into main...');

  const { codebases } = await listEnvironments();

  if (codebases.length === 0) {
    console.log('No codebases with active environments found.');
    return;
  }

  let totalCleaned = 0;
  let totalSkipped = 0;

  for (const codebase of codebases) {
    try {
      console.log(`\nChecking ${codebase.repositoryUrl ?? codebase.defaultCwd}...`);

      const result = await cleanupMergedEnvironments(
        codebase.codebaseId,
        codebase.defaultCwd,
        options
      );

      for (const branch of result.removed) {
        console.log(`  Cleaned: ${branch}`);
      }
      for (const skip of result.skipped) {
        console.log(`  Skipped: ${skip.branchName} (${skip.reason})`);
      }

      totalCleaned += result.removed.length;
      totalSkipped += result.skipped.length;
    } catch (error) {
      const err = error as Error;
      getLog().warn({ err, codebaseId: codebase.codebaseId }, 'merged_cleanup_failed');
      console.error(`  Error processing codebase: ${err.message}`);
    }
  }

  console.log(
    `\nMerged cleanup complete: ${String(totalCleaned)} cleaned, ${String(totalSkipped)} skipped`
  );
}

/**
 * Complete branch lifecycle — remove worktree, local branch, remote branch, mark DB as destroyed
 */
export async function isolationCompleteCommand(
  branchNames: string[],
  options: { force?: boolean; deleteRemote?: boolean }
): Promise<void> {
  let completed = 0;
  let failed = 0;
  let notFound = 0;

  for (const branch of branchNames) {
    let env: Awaited<ReturnType<typeof isolationDb.findActiveByBranchName>>;
    try {
      env = await isolationDb.findActiveByBranchName(branch);
    } catch (error) {
      const err = error as Error;
      getLog().error({ err, branch }, 'isolation.lookup_failed');
      console.error(`  Failed: ${branch} — DB lookup error: ${err.message}`);
      failed++;
      continue;
    }

    if (!env) {
      console.log(`  Not found: ${branch} (no active isolation environment)`);
      notFound++;
      continue;
    }

    // Run all safety checks before removing — collect all blockers, report at once.
    // Skipped entirely when --force is set.
    if (!options.force) {
      const blockers: string[] = [];

      // Check 1: uncommitted changes in worktree
      try {
        const hasChanges = await hasUncommittedChanges(toWorktreePath(env.working_path));
        if (hasChanges) {
          blockers.push('uncommitted changes in worktree');
        }
      } catch (error) {
        getLog().warn(
          { err: error as Error, branch },
          'isolation.complete_uncommitted_check_failed'
        );
        blockers.push('could not verify uncommitted changes (worktree path may be missing)');
      }

      // Check 2: running workflow on this branch
      try {
        const activeRun = await workflowDb.getActiveWorkflowRunByPath(env.working_path);
        if (activeRun) {
          blockers.push(`running workflow: ${activeRun.workflow_name} (id: ${activeRun.id})`);
        }
      } catch (error) {
        getLog().warn({ err: error as Error, branch }, 'isolation.complete_workflow_check_failed');
        console.warn('  Warning: could not check for running workflows — skipping workflow check');
      }

      // Check 3: open PRs on this branch (requires gh CLI)
      try {
        const ghResult = await execGhWithAuthPolicy(
          ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,title'],
          {
            cwd: env.codebase_default_cwd,
            repoPath: toRepoPath(env.codebase_default_cwd),
            preference: 'prefer-stored',
            timeoutMs: 15_000,
          }
        );
        const prs = JSON.parse(ghResult.stdout) as { number: number; title: string }[];
        for (const pr of prs) {
          blockers.push(`open PR #${pr.number} — "${pr.title}"`);
        }
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        const isNotInstalled = err.code === 'ENOENT' || err.message.includes('command not found');
        const reason = isNotInstalled ? 'gh CLI not available' : `gh error: ${err.message}`;
        console.warn(`  Warning: ${reason} — skipping open PR check`);
        getLog().warn({ err, branch }, 'isolation.complete_pr_check_failed');
      }

      // Check 4: unmerged commits (not yet in default branch)
      try {
        const defaultBranch = await getDefaultBranch(toRepoPath(env.codebase_default_cwd));
        const unmergedResult = await execFileAsync(
          'git',
          ['-C', env.codebase_default_cwd, 'log', `${defaultBranch}..${branch}`, '--oneline'],
          { timeout: 15000 }
        );
        const unmergedLines = unmergedResult.stdout.trim().split('\n').filter(Boolean);
        if (unmergedLines.length > 0) {
          blockers.push(`${unmergedLines.length} commit(s) not merged into ${defaultBranch}`);
        }
      } catch (error) {
        getLog().warn({ err: error as Error, branch }, 'isolation.complete_unmerged_check_failed');
        console.warn('  Warning: could not check for unmerged commits — skipping unmerged check');
      }

      // Check 5: unpushed commits (not yet on remote)
      try {
        const unpushedResult = await execFileAsync(
          'git',
          ['-C', env.codebase_default_cwd, 'log', `origin/${branch}..${branch}`, '--oneline'],
          { timeout: 15000 }
        );
        const unpushedLines = unpushedResult.stdout.trim().split('\n').filter(Boolean);
        if (unpushedLines.length > 0) {
          blockers.push(`${unpushedLines.length} commit(s) not pushed to remote`);
        }
      } catch (error) {
        const err = error as Error;
        // origin/<branch> doesn't exist means branch was never pushed
        if (err.message.includes('unknown revision') || err.message.includes('bad revision')) {
          blockers.push('branch has never been pushed to remote');
        } else {
          getLog().warn({ err, branch }, 'isolation.complete_unpushed_check_failed');
        }
      }

      if (blockers.length > 0) {
        console.error(`  Blocked: ${branch}`);
        for (const blocker of blockers) {
          console.error(`    ✗ ${blocker}`);
        }
        console.error('  Use --force to override.');
        failed++;
        continue;
      }
    }

    try {
      const result: RemoveEnvironmentResult = await removeEnvironment(env.id, {
        force: options.force,
        deleteRemoteBranch: options.deleteRemote ?? true,
      });

      // Surface warnings from partial cleanup
      for (const warning of result.warnings) {
        console.warn(`  Warning: ${warning}`);
      }

      if (result.skippedReason) {
        console.error(`  Blocked: ${branch} — ${result.skippedReason}`);
        if (result.skippedReason === 'has uncommitted changes') {
          console.error('    Use --force to override.');
        }
        failed++;
      } else if (!result.worktreeRemoved) {
        const parts: string[] = [];
        if (result.branchDeleted) parts.push('branch deleted');
        parts.push('DB updated');
        console.error(
          `  Partial: ${branch} — worktree was not removed from disk (${parts.join(', ')})`
        );
        for (const warning of result.warnings) {
          console.error(`    ⚠ ${warning}`);
        }
        failed++;
      } else {
        console.log(`  Completed: ${branch}`);
        completed++;
      }
    } catch (error) {
      const err = error as Error;
      getLog().warn({ err, branch, envId: env.id }, 'isolation.complete_failed');
      console.error(`  Failed: ${branch} — ${err.message}`);
      failed++;
    }
  }

  console.log(`\nComplete: ${completed} completed, ${failed} failed, ${notFound} not found`);
}
