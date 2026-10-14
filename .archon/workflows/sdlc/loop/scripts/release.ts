/**
 * Release this run's claim on its work item, whatever happened in the run.
 *
 * Runs after review (and deploy) have finished, failed or been skipped, so a run that
 * broke part-way still frees the item for the next lap. Only this run's own live claim
 * is touched; a claim another run holds is never edited here.
 */

import { CLAIM_PREFIX, comments, editComment, workItem } from '../../.shared/claims.ts';
import { report, trimmed } from '../../.shared/io.ts';

const target = trimmed(process.env.INPUTS_TARGET);
const pr = trimmed(process.env.INPUTS_PR);
const run = trimmed(process.env.WORKFLOW_ID);
if (run === '') throw new Error('release: WORKFLOW_ID is not set; the engine supplies it to every exec node.');

const item = workItem(target !== '' ? target : pr);
const own = comments(item).filter(
  comment =>
    typeof comment.body === 'string' &&
    typeof comment.id === 'number' &&
    comment.body.startsWith(`${CLAIM_PREFIX}${run}`) &&
    /^\s/.test(comment.body.slice(`${CLAIM_PREFIX}${run}`.length) || ' ')
);
for (const comment of own) {
  editComment(
    item,
    comment.id as number,
    `Loop claim released: run ${run} ended. Its \`Loop review:\` comment, if any, says what it did.`
  );
}
report(own.length > 0 ? `released ${own.length} claim(s) on ${target || pr}` : `run ${run} held no claim on ${target || pr}`);
