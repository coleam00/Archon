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
  } catch {
    // Local file operations remain available when registration storage cannot be read.
    return (await findRepoRoot(cwd)) ?? cwd;
  }
}
