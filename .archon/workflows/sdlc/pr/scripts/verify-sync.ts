/**
 * Hold the base sync to its invariants, and say whether this tree is already gated.
 *
 * The preparing node merged the latest base into the branch and resolved what it
 * could. This refuses, before anything is pushed, when it reported conflicts it could
 * not resolve (naming the paths), when the base is not an ancestor of HEAD, or when
 * the tree is not clean. It then answers whether a clean green gate is already
 * recorded for this exact commit: validation runs once per tree, so a merge that
 * changed nothing keeps the implementation's green and a new tree is gated once.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_REPO: `{host, path}` of the repository the work is proposed to.
 * - INPUTS_BASE: the base branch.
 * - INPUTS_CONFLICTS: JSON list of paths the merge could not resolve.
 * - INPUTS_SUMMARY: the preparing node's account, which names why.
 */

import { git, gitOrThrow } from '../../.shared/git.ts';
import { artifactsDir, emit, refuse, text } from '../../.shared/io.ts';
import { remoteRefFor } from '../../.shared/remote.ts';
import { readTyped } from '../../.shared/typed.ts';

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
  const head = gitOrThrow('rev-parse', 'HEAD');
  // A problem reading the records only means nothing is proven recorded: the gate runs.
  const gates = readTyped<{ red_cause: string; head?: string | null }>(
    process.env.TYPED_ARTIFACTS_FILE,
    artifactsDir(),
    'green-gate'
  );
  emit({ recorded: gates.values.some(gate => gate.red_cause === '' && gate.head === head) });
} catch (error) {
  refuse(`verify-sync: ${error instanceof Error ? error.message : String(error)}`);
}
