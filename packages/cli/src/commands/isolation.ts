/**
 * Isolation commands - list, cleanup, and complete worktrees
 */
import * as isolationDb from '@harneeslab/core/db/isolation-environments';
import * as workflowDb from '@harneeslab/core/db/workflows';
import { createLogger } from '@harneeslab/paths';
import {
  toRepoPath,
  toBranchName,
  execFileAsync,
  hasUncommittedChanges,
  toWorktreePath,
  getDefaultBranch,
} from '@harneeslab/git';
import { getIsolationProvider } from '@harneeslab/isolation';
import {
  removeEnvironment,
  type RemoveEnvironmentResult,
} from '@harneeslab/core/services/cleanup-service';
import {
  listEnvironments,
  cleanupMergedEnvironments,
} from '@harneeslab/core/operations/isolation-operations';

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
    console.log('등록된 codebase가 없습니다.');
    console.log('/clone 또는 --branch로 작업공간/워크트리를 만드세요.');
    return;
  }

  for (const codebase of codebases) {
    console.log(`\n${codebase.repositoryUrl ?? codebase.defaultCwd}:`);

    for (const env of codebase.environments) {
      const age =
        env.days_since_activity !== null
          ? `${Math.floor(env.days_since_activity)}일 전`
          : '알 수 없음';
      const platform = env.created_by_platform ?? '알 수 없음';

      console.log(`  ${env.branch_name ?? env.workflow_id}`);
      console.log(`    경로: ${env.working_path}`);
      console.log(`    유형: ${env.workflow_type} | Platform: ${platform} | 최근 활동: ${age}`);
    }
  }

  if (ghostsReconciled > 0) {
    console.log(`\n디스크에 없는 ghost 작업공간 ${String(ghostsReconciled)}개를 정리했습니다.`);
  }

  if (totalEnvironments === 0) {
    console.log('활성 isolation 작업공간이 없습니다.');
  } else {
    console.log(`\n총 ${String(totalEnvironments)}개 작업공간`);
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
    console.log(`디스크에 없는 ghost 작업공간 ${String(ghostsReconciled)}개를 정리했습니다.`);
  }

  console.log(`${String(daysStale)}일 이상 활동이 없는 작업공간을 찾는 중...`);

  const staleEnvs = await isolationDb.findStaleEnvironments(daysStale);

  if (staleEnvs.length === 0) {
    console.log('오래된 작업공간을 찾지 못했습니다.');
    return;
  }

  console.log(`오래된 작업공간 ${String(staleEnvs.length)}개를 찾았습니다:`);

  const provider = getIsolationProvider();
  let cleaned = 0;
  let failed = 0;

  for (const env of staleEnvs) {
    console.log(`\n정리 중: ${env.branch_name ?? env.workflow_id}`);
    console.log(`  경로: ${env.working_path}`);

    try {
      await provider.destroy(env.working_path, {
        branchName: env.branch_name ? toBranchName(env.branch_name) : undefined,
        canonicalRepoPath: toRepoPath(env.codebase_default_cwd),
      });

      await isolationDb.updateStatus(env.id, 'destroyed');
      console.log('  상태: 정리됨');
      cleaned++;
    } catch (error) {
      const err = error as Error;
      getLog().warn({ err, envId: env.id, path: env.working_path }, 'worktree_destroy_failed');
      console.error(`  상태: 실패 - ${err.message}`);
      failed++;
    }
  }

  console.log(`\n정리 완료: ${String(cleaned)}개 정리됨, ${String(failed)}개 실패`);
}

/**
 * Cleanup merged isolation environments (branches merged into main)
 * Also deletes remote branches for merged environments
 */
export async function isolationCleanupMergedCommand(
  options: { includeClosed?: boolean } = {}
): Promise<void> {
  console.log('main에 merge된 branch가 있는 작업공간을 찾는 중...');

  const { codebases } = await listEnvironments();

  if (codebases.length === 0) {
    console.log('활성 작업공간이 있는 codebase를 찾지 못했습니다.');
    return;
  }

  let totalCleaned = 0;
  let totalSkipped = 0;

  for (const codebase of codebases) {
    try {
      console.log(`\n확인 중: ${codebase.repositoryUrl ?? codebase.defaultCwd}...`);

      const result = await cleanupMergedEnvironments(
        codebase.codebaseId,
        codebase.defaultCwd,
        options
      );

      for (const branch of result.removed) {
        console.log(`  정리됨: ${branch}`);
      }
      for (const skip of result.skipped) {
        console.log(`  건너뜀: ${skip.branchName} (${skip.reason})`);
      }

      totalCleaned += result.removed.length;
      totalSkipped += result.skipped.length;
    } catch (error) {
      const err = error as Error;
      getLog().warn({ err, codebaseId: codebase.codebaseId }, 'merged_cleanup_failed');
      console.error(`  codebase 처리 오류: ${err.message}`);
    }
  }

  console.log(
    `\nmerge된 작업공간 정리 완료: ${String(totalCleaned)}개 정리됨, ${String(totalSkipped)}개 건너뜀`
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
      console.error(`  실패: ${branch} - DB 조회 오류: ${err.message}`);
      failed++;
      continue;
    }

    if (!env) {
      console.log(`  찾지 못함: ${branch} (활성 isolation 작업공간 없음)`);
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
          blockers.push('worktree에 커밋되지 않은 변경사항이 있음');
        }
      } catch (error) {
        getLog().warn(
          { err: error as Error, branch },
          'isolation.complete_uncommitted_check_failed'
        );
        blockers.push('커밋되지 않은 변경사항을 확인할 수 없음 (worktree 경로가 없을 수 있음)');
      }

      // Check 2: running workflow on this branch
      try {
        const activeRun = await workflowDb.getActiveWorkflowRunByPath(env.working_path);
        if (activeRun) {
          blockers.push(`실행 중인 workflow: ${activeRun.workflow_name} (id: ${activeRun.id})`);
        }
      } catch (error) {
        getLog().warn({ err: error as Error, branch }, 'isolation.complete_workflow_check_failed');
        console.warn('  경고: 실행 중인 workflow를 확인하지 못해 workflow 확인을 건너뜁니다');
      }

      // Check 3: open PRs on this branch (requires gh CLI)
      try {
        const ghResult = await execFileAsync(
          'gh',
          ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,title'],
          { timeout: 15000 }
        );
        const prs = JSON.parse(ghResult.stdout) as { number: number; title: string }[];
        for (const pr of prs) {
          blockers.push(`열린 PR #${pr.number} - "${pr.title}"`);
        }
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        const isNotInstalled = err.code === 'ENOENT' || err.message.includes('command not found');
        const reason = isNotInstalled ? 'gh CLI를 사용할 수 없음' : `gh 오류: ${err.message}`;
        console.warn(`  경고: ${reason} - open PR 확인을 건너뜁니다`);
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
          blockers.push(`${unmergedLines.length}개 commit이 ${defaultBranch}에 merge되지 않음`);
        }
      } catch (error) {
        getLog().warn({ err: error as Error, branch }, 'isolation.complete_unmerged_check_failed');
        console.warn('  경고: merge되지 않은 commit을 확인하지 못해 해당 확인을 건너뜁니다');
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
          blockers.push(`${unpushedLines.length}개 commit이 remote에 push되지 않음`);
        }
      } catch (error) {
        const err = error as Error;
        // origin/<branch> doesn't exist means branch was never pushed
        if (err.message.includes('unknown revision') || err.message.includes('bad revision')) {
          blockers.push('branch가 remote에 한 번도 push되지 않음');
        } else {
          getLog().warn({ err, branch }, 'isolation.complete_unpushed_check_failed');
        }
      }

      if (blockers.length > 0) {
        console.error(`  차단됨: ${branch}`);
        for (const blocker of blockers) {
          console.error(`    ✗ ${blocker}`);
        }
        console.error('  무시하고 진행하려면 --force를 사용하세요.');
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
        console.warn(`  경고: ${warning}`);
      }

      if (result.skippedReason) {
        console.error(`  차단됨: ${branch} - ${formatSkippedReason(result.skippedReason)}`);
        if (result.skippedReason === 'has uncommitted changes') {
          console.error('    무시하고 진행하려면 --force를 사용하세요.');
        }
        failed++;
      } else if (!result.worktreeRemoved) {
        const parts: string[] = [];
        if (result.branchDeleted) parts.push('branch 삭제됨');
        parts.push('DB 업데이트됨');
        console.error(
          `  부분 완료: ${branch} - worktree가 디스크에서 제거되지 않았습니다 (${parts.join(', ')})`
        );
        for (const warning of result.warnings) {
          console.error(`    ⚠ ${warning}`);
        }
        failed++;
      } else {
        console.log(`  완료: ${branch}`);
        completed++;
      }
    } catch (error) {
      const err = error as Error;
      getLog().warn({ err, branch, envId: env.id }, 'isolation.complete_failed');
      console.error(`  실패: ${branch} - ${err.message}`);
      failed++;
    }
  }

  console.log(`\n완료: ${completed}개 완료, ${failed}개 실패, ${notFound}개 찾지 못함`);
}

function formatSkippedReason(reason: string): string {
  if (reason === 'has uncommitted changes') return '커밋되지 않은 변경사항이 있음';
  return reason;
}
