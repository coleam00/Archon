import { findRepoRoot } from '@archon/git';
import { canonicalizeProjectPath } from '@archon/paths';
import { resolveCodebaseForPath } from '@archon/core/services/codebase-checkout-resolver';
import { createCliWorkflowHost } from './workflow-host';

export async function resolveDiscoveryCwd(cwd: string): Promise<string> {
  cwd = await canonicalizeProjectPath(cwd);
  try {
    const host = await createCliWorkflowHost();
    const { codebase, repoRoot } = await resolveCodebaseForPath(cwd, host.records.codebases);
    return codebase?.kind === 'folder' ? codebase.default_cwd : (repoRoot ?? cwd);
  } catch (error) {
    // File-only discovery can still inspect a proven Git root without a registry.
    const repoRoot = await findRepoRoot(cwd);
    if (repoRoot) return repoRoot;
    throw error;
  }
}
