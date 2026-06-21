import { execFileAsync } from './exec';

export interface RetryRefIdentity {
  runId: string;
  retryEpoch: number;
}

export interface CheckpointRefIdentity extends RetryRefIdentity {
  nodeId: string;
}

export interface RetryRefResult {
  ref: string;
  commitSha: string;
  createdCommit: boolean;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd });
  return result.stdout.trim();
}

export function buildCheckpointRef(identity: CheckpointRefIdentity): string {
  return `refs/archon/checkpoints/${identity.runId}/${String(identity.retryEpoch)}/${identity.nodeId}`;
}

export function buildRetrySafetyRef(identity: RetryRefIdentity): string {
  return `refs/archon/retry-safety/${identity.runId}/${String(identity.retryEpoch)}`;
}

export async function assertGitRepository(repoPath: string): Promise<void> {
  try {
    const result = await git(repoPath, ['rev-parse', '--is-inside-work-tree']);
    if (result !== 'true') {
      throw new Error(`Not a git repository: ${repoPath}`);
    }
  } catch (err) {
    throw new Error(
      `Retry checkpoint operations require a git repository: ${(err as Error).message}`
    );
  }
}

export async function validateGitRef(repoPath: string, ref: string): Promise<void> {
  try {
    await git(repoPath, ['check-ref-format', ref]);
  } catch (err) {
    throw new Error(`Invalid git ref '${ref}': ${(err as Error).message}`);
  }
}

export async function verifyCommitRef(repoPath: string, refOrSha: string): Promise<string> {
  try {
    return await git(repoPath, ['rev-parse', '--verify', `${refOrSha}^{commit}`]);
  } catch (err) {
    throw new Error(`Invalid git commit ref '${refOrSha}': ${(err as Error).message}`);
  }
}

export async function hasTrackedChanges(repoPath: string): Promise<boolean> {
  await assertGitRepository(repoPath);
  const status = await git(repoPath, ['status', '--porcelain', '--untracked-files=no']);
  return status.length > 0;
}

async function requireCommitIdentity(repoPath: string): Promise<void> {
  const [name, email] = await Promise.all([
    git(repoPath, ['config', '--get', 'user.name']).catch(() => ''),
    git(repoPath, ['config', '--get', 'user.email']).catch(() => ''),
  ]);
  if (!name || !email) {
    throw new Error(
      'Cannot create retry checkpoint commit without git user.name and user.email configured.'
    );
  }
}

export async function createTrackedChangesCommit(
  repoPath: string,
  message: string
): Promise<{ commitSha: string; createdCommit: boolean }> {
  await assertGitRepository(repoPath);
  if (!(await hasTrackedChanges(repoPath))) {
    return { commitSha: await verifyCommitRef(repoPath, 'HEAD'), createdCommit: false };
  }

  await requireCommitIdentity(repoPath);
  await git(repoPath, ['add', '-u']);
  await git(repoPath, ['commit', '-m', message]);
  return { commitSha: await verifyCommitRef(repoPath, 'HEAD'), createdCommit: true };
}

export async function upsertCheckpointRef(
  repoPath: string,
  identity: CheckpointRefIdentity
): Promise<RetryRefResult> {
  const ref = buildCheckpointRef(identity);
  await validateGitRef(repoPath, ref);
  const result = await createTrackedChangesCommit(
    repoPath,
    `archon checkpoint ${identity.runId}/${String(identity.retryEpoch)}/${identity.nodeId}`
  );
  await git(repoPath, ['update-ref', ref, result.commitSha]);
  return { ref, commitSha: result.commitSha, createdCommit: result.createdCommit };
}

export async function createRetrySafetyRef(
  repoPath: string,
  identity: RetryRefIdentity
): Promise<RetryRefResult> {
  const ref = buildRetrySafetyRef(identity);
  await validateGitRef(repoPath, ref);
  const result = await createTrackedChangesCommit(
    repoPath,
    `archon retry safety ${identity.runId}/${String(identity.retryEpoch)}`
  );
  await git(repoPath, ['update-ref', ref, result.commitSha]);
  return { ref, commitSha: result.commitSha, createdCommit: result.createdCommit };
}

export async function resetTrackedFilesToCommit(
  repoPath: string,
  refOrSha: string
): Promise<string> {
  const commitSha = await verifyCommitRef(repoPath, refOrSha);
  await git(repoPath, ['reset', '--hard', commitSha]);
  return commitSha;
}
