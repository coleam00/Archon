/**
 * Whether anything moved a checkout's HEAD between two instants (#5769). Read-only, through
 * the same git reader as checkout observation.
 */
import { createHash } from 'node:crypto';
import type { ExecutionContext } from '@archon/provider-contract';
import { hasGitMarker, runGit, text } from './checkout-observation';

/**
 * A fingerprint of every move HEAD has made in this checkout: the reflog of HEAD and of
 * the branch it is on (a ref update that bypasses HEAD logs only to the branch). Two equal
 * marks mean nothing moved HEAD between them, which two equal commit samples cannot show:
 * a checkout moved to another commit and back reads the same commit twice. Null when the
 * moves cannot be seen: a container backend, a failed read, or a checkout whose HEAD keeps
 * no reflog (`core.logAllRefUpdates` off). A caller treats null as "may have moved".
 */
export async function readCheckoutMark(
  cwd: string,
  execContext: ExecutionContext
): Promise<string | null> {
  if (execContext.kind === 'container' || !hasGitMarker(cwd)) return null;
  const format = '--format=%H %gs';
  const head = await runGit(cwd, ['reflog', 'show', format, 'HEAD', '--']);
  if (head.code !== 0 || head.stdout.length === 0) return null;
  const symbolic = await runGit(cwd, ['symbolic-ref', '-q', 'HEAD']);
  // Exit 1 is a detached HEAD, which has no branch; anything else is a failed read.
  if (symbolic.code !== 0 && symbolic.code !== 1) return null;
  const ref = symbolic.code === 0 ? text(symbolic.stdout) : '';
  const branch = ref === '' ? null : await runGit(cwd, ['reflog', 'show', format, ref, '--']);
  if (branch !== null && branch.code !== 0) return null;
  return createHash('sha256')
    .update(head.stdout)
    .update(`\0${ref}\0`)
    .update(branch?.stdout ?? '')
    .digest('hex');
}
