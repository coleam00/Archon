import {
  deleteRemoteBranchTracked,
  getGitCommandAnchors,
  readRemoteBranchOid,
  type DestroyResult,
} from '@archon/isolation';

/** Capture the approved remote ref before the claim; execute only after it commits. */
export async function prepareRemoteBranchCleanup(
  repoPath: string,
  branchName: string,
  remote: string
): Promise<(result: DestroyResult) => Promise<void>> {
  const durable = (await getGitCommandAnchors(repoPath)).durable;
  try {
    const oid = await readRemoteBranchOid(durable, branchName, remote);
    return async result => {
      await deleteRemoteBranchTracked(durable, branchName, result, remote, oid);
    };
  } catch {
    const warning = 'Remote branch cleanup skipped: could not inspect the remote ref';
    return async result => {
      result.warnings.push(warning);
    };
  }
}
