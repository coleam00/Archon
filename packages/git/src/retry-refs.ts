import { execFileAsync } from './exec';

export interface RetryRefIdentity {
  runId: string;
  retryEpoch: number;
}

export interface CheckpointRefIdentity extends RetryRefIdentity {
  workflowName: string;
  nodeId: string;
}

export interface RetrySafetyRefIdentity extends RetryRefIdentity {
  workflowName: string;
  nodeId: string;
}

export interface RetryRefResult {
  ref: string;
  commitSha: string;
  createdCommit: boolean;
}

export interface DeleteRetryRefsResult {
  deletedRefs: string[];
  warnings: string[];
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

export async function hasGitVisibleChanges(repoPath: string): Promise<boolean> {
  await assertGitRepository(repoPath);
  const status = await git(repoPath, ['status', '--porcelain', '--untracked-files=all']);
  return status.length > 0;
}

export const hasTrackedChanges = hasGitVisibleChanges;

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

function normalizeAuditText(value: string): string {
  return Array.from(value, char => {
    const code = char.charCodeAt(0);
    return code <= 31 || code === 127 ? ' ' : char;
  }).join('');
}

function buildCheckpointCommitMessage(identity: CheckpointRefIdentity): string {
  const workflowName = normalizeAuditText(identity.workflowName);
  const nodeId = normalizeAuditText(identity.nodeId);
  return `archon checkpoint: ${workflowName}/${nodeId}\n\nRun: ${identity.runId}\nEpoch: ${String(identity.retryEpoch)}\nNode: ${nodeId}`;
}

function buildRetrySafetyCommitMessage(identity: RetrySafetyRefIdentity): string {
  const workflowName = normalizeAuditText(identity.workflowName);
  const nodeId = normalizeAuditText(identity.nodeId);
  return `archon retry safety: ${workflowName}\n\nRun: ${identity.runId}\nEpoch: ${String(identity.retryEpoch)}\nRetry node: ${nodeId}`;
}

export async function createGitVisibleChangesCommit(
  repoPath: string,
  message: string
): Promise<{ commitSha: string; createdCommit: boolean }> {
  await assertGitRepository(repoPath);
  if (!(await hasGitVisibleChanges(repoPath))) {
    return { commitSha: await verifyCommitRef(repoPath, 'HEAD'), createdCommit: false };
  }

  await requireCommitIdentity(repoPath);
  await git(repoPath, ['add', '-A']);
  await git(repoPath, ['commit', '-m', message]);
  return { commitSha: await verifyCommitRef(repoPath, 'HEAD'), createdCommit: true };
}

export const createTrackedChangesCommit = createGitVisibleChangesCommit;

export async function upsertCheckpointRef(
  repoPath: string,
  identity: CheckpointRefIdentity
): Promise<RetryRefResult> {
  const ref = buildCheckpointRef(identity);
  await validateGitRef(repoPath, ref);
  const result = await createGitVisibleChangesCommit(
    repoPath,
    buildCheckpointCommitMessage(identity)
  );
  await git(repoPath, ['update-ref', ref, result.commitSha]);
  return { ref, commitSha: result.commitSha, createdCommit: result.createdCommit };
}

export async function createRetrySafetyRef(
  repoPath: string,
  identity: RetrySafetyRefIdentity
): Promise<RetryRefResult> {
  const ref = buildRetrySafetyRef(identity);
  await validateGitRef(repoPath, ref);
  const result = await createGitVisibleChangesCommit(
    repoPath,
    buildRetrySafetyCommitMessage(identity)
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

export async function deleteRetryRefsByRunId(
  repoPath: string,
  runId: string
): Promise<DeleteRetryRefsResult> {
  await assertGitRepository(repoPath);
  const prefixes = [
    `refs/archon/checkpoints/${runId}`,
    `refs/archon/retry-safety/${runId}`,
  ] as const;
  const refsOutput = await git(repoPath, ['for-each-ref', '--format=%(refname)', ...prefixes]);
  const refs = refsOutput
    .split('\n')
    .map(ref => ref.trim())
    .filter(ref => ref.length > 0);

  const deletedRefs: string[] = [];
  const warnings: string[] = [];
  for (const ref of refs) {
    try {
      await git(repoPath, ['update-ref', '-d', ref]);
      deletedRefs.push(ref);
    } catch (err) {
      warnings.push(`Failed to delete retry ref '${ref}': ${(err as Error).message}`);
    }
  }
  return { deletedRefs, warnings };
}
