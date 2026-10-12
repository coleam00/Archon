/**
 * Hold the base sync to its invariants.
 *
 * The preparing node merged the latest base into the branch and resolved what it
 * could. This refuses, before anything is pushed, when it reported conflicts it could
 * not resolve (naming the paths), when the base is not an ancestor of HEAD, or when
 * the tree is not clean.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_REPO: `{host, path}` of the repository the work is proposed to.
 * - INPUTS_BASE: the base branch.
 * - INPUTS_CONFLICTS: JSON list of paths the merge could not resolve.
 * - INPUTS_SUMMARY: the preparing node's account, which names why.
 */

import { git, gitOrThrow } from '../../.shared/git.ts';
import { refuse, report, text } from '../../.shared/io.ts';
import { remoteRefFor } from '../../.shared/remote.ts';

try {
  const conflicts = JSON.parse(text(process.env.INPUTS_CONFLICTS)) as string[];
  if (conflicts.length > 0) {
    throw new Error(
      `the base merge left conflicts it could not resolve with confidence: ${conflicts.join(', ')}. ` +
        text(process.env.INPUTS_SUMMARY)
    );
  }
  const repo = JSON.parse(text(process.env.INPUTS_REPO)) as { host: string; path: string };
  const base = remoteRefFor(repo, text(process.env.INPUTS_BASE));
  const ancestor = git('merge-base', '--is-ancestor', base, 'HEAD');
  if (ancestor.code === 1) throw new Error(`${base} is not an ancestor of HEAD: the latest base was not merged in`);
  if (ancestor.code !== 0) throw new Error(`git merge-base --is-ancestor failed: ${ancestor.stderr}`);
  const status = gitOrThrow('status', '--porcelain');
  if (status !== '') throw new Error(`the tree is not clean after the base merge:\n${status}`);
  report(`verify-sync: ${base} is merged and the tree is clean`);
} catch (error) {
  refuse(`verify-sync: ${error instanceof Error ? error.message : String(error)}`);
}
