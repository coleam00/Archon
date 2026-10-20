/**
 * Isolation commands - list, cleanup, and complete worktrees
 */
import type { IsolationEnvironmentRow } from '@archon/isolation/types';
import { getCodebase } from '@archon/core/db/codebases';
import * as isolationDb from '@archon/core/db/isolation-environments';
import { loadRepoConfig } from '@archon/core';
import { createLogger } from '@archon/paths';
import {
  toRepoPath,
  toBranchName,
  execFileAsync,
  hasUncommittedChangesStrict,
  worktreeExists,
  toWorktreePath,
  getDefaultBranch,
  getUniqueCommitCount,
  isPatchEquivalent,
} from '@archon/git';
import {
  getIsolationProvider,
  readWorktreeBranchCreated,
  readWorktreeCreationId,
} from '@archon/isolation';
import {
  getLiveRunBlocker,
  removeEnvironment,
  getCleanupRunLock,
  listContainerEnvironments,
  cleanupContainerEnvironments,
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
      if (env.cleanupSkipReason) console.log(`    Cleanup skipped: ${env.cleanupSkipReason}`);
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
    console.log(`\nTotal: ${String(totalEnvironments)} worktree environment(s)`);
  }

  // Container isolation environments (folder-project container backend). These are
  // not worktrees — they're labeled Docker containers + upper volumes. A paused
  // run's container shows here (awaiting approve/resume) and is never auto-pruned.
  const containers = await listContainerEnvironments();
  if (containers.length > 0) {
    console.log('\nContainer environments (folder projects):');
    for (const c of containers) {
      const runPart = c.runId ? `run ${c.runId.slice(0, 8)} (${c.runStatus})` : 'no run (orphan)';
      console.log(`  ${c.envId.slice(0, 8)} — ${c.codebaseName}`);
      console.log(`    Path: ${c.workingPath}`);
      console.log(`    ${runPart} | Age: ${c.ageDays}d`);
    }
    console.log(`\nTotal: ${String(containers.length)} container environment(s)`);
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
  const { ghostsReconciled, codebases } = await listEnvironments();
  if (ghostsReconciled > 0) {
    console.log(`Reconciled ${String(ghostsReconciled)} ghost environment(s) (missing from disk).`);
  }

  for (const codebase of codebases) {
    for (const env of codebase.environments) {
      if (env.cleanupSkipReason) {
        console.log(`Skipped: ${env.branch_name ?? env.workflow_id} (${env.cleanupSkipReason})`);
      }
    }
  }

  console.log(`Finding environments with no activity for ${String(daysStale)}+ days...`);

  const staleEnvs = (await isolationDb.findStaleEnvironments(daysStale)).filter(
    env => env.provider === 'worktree'
  );

  if (staleEnvs.length === 0) {
    console.log('No stale worktree environments found.');
  } else {
    console.log(`Found ${String(staleEnvs.length)} stale worktree environment(s):`);
  }

  const provider = getIsolationProvider();
  let cleaned = 0;
  let skipped = 0;
  let failed = 0;

  for (const env of staleEnvs) {
    console.log(`\nCleaning: ${env.branch_name ?? env.workflow_id}`);
    console.log(`  Path: ${env.working_path}`);

    try {
      // Same lock the cleanup-service sweeps use: a run that can still claim the
      // environment blocks removal, even when the conversation recency filter
      // marks the env stale. A failed run past the window no longer does.
      const lock = await getCleanupRunLock(env, toRepoPath(env.codebase_default_cwd), {
        kind: 'stale',
        staleDays: daysStale,
      });
      if (lock.kind === 'locked') {
        const { runId, runStatus, display } = lock.blocker;
        getLog().info({ envId: env.id, runId, runStatus }, 'skip_stale_live_run');
        console.log(`  Status: Skipped — ${display}`);
        skipped++;
        continue;
      }
      if (lock.kind === 'unpushed') {
        getLog().warn(
          { envId: env.id, ...(lock.runId ? { runId: lock.runId } : {}) },
          'skip_stale_unpushed_commits'
        );
        console.log(`  Status: Skipped — ${lock.display}`);
        skipped++;
        continue;
      }

      await isolationDb.withWorktreeRegistration(env, async markDestroyed => {
        const result = await provider.destroy(env.working_path, {
          // A stale environment's branch is deleted only when the environment created it;
          // an existing branch it checked out may hold commits that exist nowhere else.
          branchName:
            env.branch_name && readWorktreeBranchCreated(env.metadata)
              ? toBranchName(env.branch_name)
              : undefined,
          canonicalRepoPath: toRepoPath(env.codebase_default_cwd),
          creationId: readWorktreeCreationId(env.metadata) ?? undefined,
        });

        if (!result.worktreeRemoved || !result.directoryClean) {
          throw new Error(
            `Worktree removal incomplete; environment retained. ${result.warnings.join('; ')}`
          );
        }
        await markDestroyed();
      });
      console.log(
        lock.kind === 'released'
          ? `  Status: Cleaned (failed run ${lock.runId.slice(0, 8)} released: ${lock.reason})`
          : '  Status: Cleaned'
      );
      cleaned++;
    } catch (error) {
      const err = error as Error;
      getLog().warn({ err, envId: env.id, path: env.working_path }, 'worktree_destroy_failed');
      console.error(`  Status: Failed - ${err.message}`);
      failed++;
    }
  }

  console.log(
    `\nCleanup complete: ${String(cleaned)} cleaned, ${String(skipped)} skipped, ${String(failed)} failed`
  );

  // Reap orphaned container environments (terminal / run-less, older than the
  // threshold). Paused runs' containers are deliberately skipped (awaited state).
  const containerReport = await cleanupContainerEnvironments(daysStale);
  const containerTotal =
    containerReport.removed.length + containerReport.skipped.length + containerReport.errors.length;
  if (containerTotal > 0) {
    console.log('\nContainer environments:');
    for (const id of containerReport.removed) {
      console.log(`  Removed: ${id.slice(0, 8)}`);
    }
    for (const s of containerReport.skipped) {
      console.log(`  Skipped: ${s.id.slice(0, 8)} — ${s.reason}`);
    }
    for (const e of containerReport.errors) {
      console.error(`  Failed: ${e.id.slice(0, 8)} — ${e.error}`);
    }
    console.log(
      `Container cleanup: ${String(containerReport.removed.length)} removed, ` +
        `${String(containerReport.skipped.length)} skipped, ` +
        `${String(containerReport.errors.length)} failed`
    );
  }
}

/**
 * Cleanup merged isolation environments (branches merged into each repo's base branch)
 * Also deletes remote branches for merged environments
 */
export async function isolationCleanupMergedCommand(
  options: { includeClosed?: boolean } = {}
): Promise<void> {
  console.log('Finding environments with branches merged into their base branch...');

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

      // The base ref comes back from the sweep that compared against it, so the
      // operator sees the repo's configured base branch rather than an assumed one.
      console.log(`  Base: ${result.baseRef}`);

      for (const branch of result.removed) {
        console.log(`  Cleaned: ${branch}`);
      }
      for (const { branchName, runId, reason } of result.releasedFailedRuns) {
        console.log(`  Released failed run ${runId.slice(0, 8)} (${reason}): ${branchName}`);
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

type CompletionEnvironment = IsolationEnvironmentRow & { codebase_default_cwd: string };
type CompletionOptions = Parameters<typeof isolationCompleteCommand>[1];
type CompletionOutcome = 'completed' | 'failed' | 'notFound';

async function checkCompletionWorktree(
  env: CompletionEnvironment,
  branch: string,
  blockers: string[]
): Promise<void> {
  try {
    const workingPath = toWorktreePath(env.working_path);
    if ((await worktreeExists(workingPath)) && (await hasUncommittedChangesStrict(workingPath))) {
      blockers.push('uncommitted changes in worktree');
    }
  } catch (error) {
    getLog().warn({ err: error as Error, branch }, 'isolation.complete_uncommitted_check_failed');
    blockers.push('could not verify uncommitted changes (worktree path may be missing)');
  }
}

async function checkCompletionLiveRun(
  env: CompletionEnvironment,
  branch: string,
  blockers: string[]
): Promise<void> {
  try {
    const liveRun = await getLiveRunBlocker(env.id);
    if (liveRun) blockers.push(liveRun.display);
  } catch (error) {
    const err = error as Error;
    getLog().warn({ err, branch }, 'isolation.complete_live_run_check_failed');
    blockers.push(`could not check for a run that owns this environment (${err.message})`);
  }
}

async function checkCompletionPullRequests(
  env: CompletionEnvironment,
  branch: string,
  blockers: string[]
): Promise<void> {
  try {
    const ghResult = await execFileAsync(
      'gh',
      ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,title'],
      { timeout: 15000, cwd: env.codebase_default_cwd }
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
}

async function checkMissingRemoteBranch(
  env: CompletionEnvironment,
  branch: string,
  remote: string,
  repoConfig: Awaited<ReturnType<typeof loadRepoConfig>> | undefined,
  blockers: string[]
): Promise<void> {
  try {
    const configuredBase = repoConfig?.worktree?.baseBranch?.trim();
    const baseBranch = configuredBase
      ? toBranchName(configuredBase)
      : await getDefaultBranch(toRepoPath(env.codebase_default_cwd), remote);
    const remoteBaseRef = `${remote}/${baseBranch}`;
    if (
      await isPatchEquivalent(
        toRepoPath(env.codebase_default_cwd),
        toBranchName(branch),
        remoteBaseRef,
        { throwOnExpectedError: true }
      )
    ) {
      console.log(
        `  Note: no ${remote}/${branch} on the remote; content is already on ` +
          `${remoteBaseRef} (squash-merged, or merged locally and never pushed).`
      );
    } else {
      blockers.push(
        `no ${remote}/${branch} on the remote (deleted or never pushed) ` +
          `and content not found on ${remoteBaseRef}`
      );
    }
  } catch (patchCheckError) {
    const patchCheckErr = patchCheckError as Error;
    getLog().warn(
      { err: patchCheckErr, branch },
      'isolation.complete_remote_deleted_branch_check_failed'
    );
    blockers.push(
      `could not verify whether ${branch}'s content is already on the base branch ` +
        `(${patchCheckErr.message})`
    );
  }
}

async function isCompletionRemoteRefMissing(
  env: CompletionEnvironment,
  branch: string,
  remote: string
): Promise<boolean> {
  try {
    await execFileAsync(
      'git',
      [
        '-C',
        env.codebase_default_cwd,
        'show-ref',
        '--verify',
        '--quiet',
        `refs/remotes/${remote}/${branch}`,
      ],
      { timeout: 15000 }
    );
    return false;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 1) return true;
    getLog().warn({ err: error, branch }, 'isolation.complete_remote_ref_check_failed');
    return false;
  }
}

async function checkCompletionUnpushedCommits(
  env: CompletionEnvironment,
  branch: string,
  remote: string,
  uniqueCommitCount: number | undefined,
  repoConfig: Awaited<ReturnType<typeof loadRepoConfig>> | undefined,
  blockers: string[]
): Promise<void> {
  try {
    // Missing revisions are handled below, so every failed log remains a refusal.
    const unpushedResult = await execFileAsync(
      'git',
      [
        '-C',
        env.codebase_default_cwd,
        'log',
        '--ignore-missing',
        `${remote}/${branch}..${branch}`,
        '--oneline',
      ],
      { timeout: 15000 }
    );
    const unpushedLines = unpushedResult.stdout.trim().split('\n').filter(Boolean);
    if (unpushedLines.length > 0) {
      blockers.push(`${unpushedLines.length} commit(s) not pushed to remote`);
    }
    if (uniqueCommitCount === undefined || uniqueCommitCount === 0) return;
    if (await isCompletionRemoteRefMissing(env, branch, remote)) {
      await checkMissingRemoteBranch(env, branch, remote, repoConfig, blockers);
      return;
    }
    blockers.push(`${String(uniqueCommitCount)} commit(s) unique to this branch`);
  } catch (error) {
    const err = error as Error;
    if (uniqueCommitCount !== undefined && uniqueCommitCount > 0) {
      blockers.push(`${String(uniqueCommitCount)} commit(s) unique to this branch`);
    }
    blockers.push(
      `could not verify unpushed commits (${err.message}) — refusing to delete unverified`
    );
    getLog().warn({ err, branch }, 'isolation.complete_unpushed_check_failed');
  }
}

async function checkCompletionCommits(
  env: CompletionEnvironment,
  branch: string,
  blockers: string[]
): Promise<void> {
  let remote = 'origin';
  let uniqueCommitCount: number | undefined;
  let repoConfig: Awaited<ReturnType<typeof loadRepoConfig>> | undefined;
  try {
    repoConfig = await loadRepoConfig(env.codebase_default_cwd);
    remote = repoConfig.worktree?.remote?.trim() || remote;
    uniqueCommitCount = await getUniqueCommitCount(
      toRepoPath(env.codebase_default_cwd),
      toBranchName(branch),
      remote
    );
  } catch (error) {
    const err = error as Error;
    getLog().warn({ err, branch }, 'isolation.complete_unique_commit_check_failed');
    blockers.push(
      `could not determine unique commits (${err.message}) — refusing to delete unverified`
    );
  }

  await checkCompletionUnpushedCommits(
    env,
    branch,
    remote,
    uniqueCommitCount,
    repoConfig,
    blockers
  );
}

async function getCompletionBlockers(
  env: CompletionEnvironment,
  branch: string
): Promise<string[]> {
  const blockers: string[] = [];
  // Collect every blocker in safety-check order before attempting removal.
  await checkCompletionWorktree(env, branch, blockers);
  await checkCompletionLiveRun(env, branch, blockers);
  await checkCompletionPullRequests(env, branch, blockers);
  await checkCompletionCommits(env, branch, blockers);
  return blockers;
}

function reportCompletionResult(
  branch: string,
  result: RemoveEnvironmentResult
): CompletionOutcome {
  for (const warning of result.warnings) {
    console.warn(`  Warning: ${warning}`);
  }

  if (result.skippedReason) {
    console.error(`  Blocked: ${branch} — ${result.skippedReason}`);
    if (result.skippedReason === 'has uncommitted changes') {
      console.error('    Use --force to override.');
    }
    return 'failed';
  }
  if (!result.worktreeRemoved) {
    const parts: string[] = [];
    if (result.branchDeleted) parts.push('branch deleted');
    parts.push('DB updated');
    console.error(
      `  Partial: ${branch} — worktree was not removed from disk (${parts.join(', ')})`
    );
    for (const warning of result.warnings) {
      console.error(`    ⚠ ${warning}`);
    }
    return 'failed';
  }
  console.log(`  Completed: ${branch}`);
  return 'completed';
}

class CompletionRefusal extends Error {}

async function resolveCompletionEnvironment(branch: string): Promise<{
  env: CompletionEnvironment;
  registration: IsolationEnvironmentRow;
} | null> {
  const matches = (await isolationDb.listActive()).filter(
    candidate => candidate.branch_name === branch
  );
  if (matches.length > 1) {
    throw new CompletionRefusal(
      'multiple active environments match this branch; refusing ambiguous deletion'
    );
  }
  const selected = matches[0];
  if (selected && selected.provider !== 'worktree') {
    throw new CompletionRefusal('not a worktree environment');
  }
  if (!selected) return null;
  const codebase = await getCodebase(selected.codebase_id);
  if (!codebase) throw new CompletionRefusal('environment codebase not found');
  return {
    env: { ...selected, codebase_default_cwd: codebase.default_cwd },
    registration: selected,
  };
}

async function completeBranch(
  branch: string,
  options: CompletionOptions
): Promise<CompletionOutcome> {
  let resolved: Awaited<ReturnType<typeof resolveCompletionEnvironment>>;
  try {
    resolved = await resolveCompletionEnvironment(branch);
  } catch (error) {
    const err = error as Error;
    if (err instanceof CompletionRefusal) {
      console.error(`  Failed: ${branch} — ${err.message}`);
      return 'failed';
    }
    getLog().error({ err, branch }, 'isolation.lookup_failed');
    console.error(`  Failed: ${branch} — DB lookup error: ${err.message}`);
    return 'failed';
  }

  if (!resolved) {
    console.log(`  Not found: ${branch} (no active isolation environment)`);
    return 'notFound';
  }

  const { env, registration } = resolved;

  if (!options.force) {
    const blockers = await getCompletionBlockers(env, branch);
    if (blockers.length > 0) {
      console.error(`  Blocked: ${branch}`);
      for (const blocker of blockers) {
        console.error(`    ✗ ${blocker}`);
      }
      console.error('  Use --force to override.');
      return 'failed';
    }
  }

  try {
    const result: RemoveEnvironmentResult = await removeEnvironment(registration, {
      force: options.force,
      deleteRemoteBranch: options.deleteRemote ?? true,
    });
    return reportCompletionResult(branch, result);
  } catch (error) {
    const err = error as Error;
    getLog().warn({ err, branch, envId: env.id }, 'isolation.complete_failed');
    console.error(`  Failed: ${branch} — ${err.message}`);
    return 'failed';
  }
}

/**
 * Complete branch lifecycle — remove worktree, local branch, remote branch, mark DB as destroyed
 */
export async function isolationCompleteCommand(
  branchNames: string[],
  options: { force?: boolean; deleteRemote?: boolean }
): Promise<void> {
  const counts = { completed: 0, failed: 0, notFound: 0 };
  for (const branch of branchNames) {
    counts[await completeBranch(branch, options)]++;
  }

  console.log(
    `\nComplete: ${counts.completed} completed, ${counts.failed} failed, ${counts.notFound} not found`
  );
  if (counts.failed > 0) {
    throw new Error(`Failed to complete ${String(counts.failed)} branch(es)`);
  }
}
