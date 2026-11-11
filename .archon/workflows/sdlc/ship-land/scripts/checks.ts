/**
 * The checks at a pull request's head, read once: what the landing loop waits on and
 * what the run reports when they do not end green.
 *
 * It reads the same snapshot the merge gate reads, so `state` is the gate's own
 * reading: `red` as soon as one check failed, `pending` while any runs and none
 * failed, `none` when the head has no check yet. `settled` is true once no check is
 * still running and at least one exists. An unreadable pull request fails the node.
 *
 * Bound inputs (canonical text in env):
 * - INPUTS_PR_URL: the pull request's URL.
 */

import { emit, refuse, trimmed } from '../../.shared/io.ts';
import { readMaintainers } from '../../.shared/maintainers.ts';
import { readPr } from '../../.shared/merge.ts';
import { prFromUrl } from '../../.shared/pr.ts';

try {
  const pr = prFromUrl(trimmed(process.env.INPUTS_PR_URL));
  const { head_revision: head, checks } = readPr(pr, readMaintainers(pr.repo));
  emit({
    head,
    state: checks.state,
    failing: checks.failing,
    pending: checks.pending,
    settled: checks.pending.length === 0 && checks.state !== 'none',
    read_at: new Date().toISOString(),
  });
} catch (error) {
  refuse(`ship-land checks: ${error instanceof Error ? error.message : String(error)}`);
}
