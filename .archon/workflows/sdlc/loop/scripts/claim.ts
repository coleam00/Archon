/**
 * Claim the work item pick chose, so a parallel run of this loop never works it too.
 *
 * Posts this run's claim, reads the item back, and holds it only when this run's claim
 * is the oldest live one. A run that lost the race withdraws its claim and does no work
 * this lap; the next lap picks again. Pick already skips claimed items, so a lost race
 * means two picks chose the same item within moments of each other.
 *
 * A claim already on the item for this same run (a resumed run) is reused, not doubled.
 */

import { CLAIM_PREFIX, editComment, expiryHours, liveClaims, postComment, workItem } from '../../.shared/claims.ts';
import { emit, trimmed } from '../../.shared/io.ts';

const target = trimmed(process.env.INPUTS_TARGET);
const pr = trimmed(process.env.INPUTS_PR);
const route = trimmed(process.env.INPUTS_ROUTE);
const area = trimmed(process.env.INPUTS_AREA);
const hours = expiryHours(trimmed(process.env.INPUTS_CLAIM_HOURS));
const run = trimmed(process.env.WORKFLOW_ID);
if (run === '') throw new Error('claim: WORKFLOW_ID is not set; the engine supplies it to every exec node.');

const item = workItem(target !== '' ? target : pr);
let claims = liveClaims(item, hours);
let mine = claims.find(claim => claim.run === run);
if (mine === undefined) {
  const body = [
    `${CLAIM_PREFIX}${run}`,
    '',
    `Route: ${route}${pr !== '' ? ` (${pr})` : ''}`,
    `Area: ${area !== '' ? area : 'not stated'}`,
    '',
    `This loop is working this item. Other runs of the loop leave it, and work in the area above, alone until this claim is released or is ${hours} hours old.`,
  ].join('\n');
  postComment(item, body);
  // A rival's claim posted a moment earlier may not be readable yet; let it settle so
  // both runs read the same set of claims back.
  Bun.sleepSync(5000);
  claims = liveClaims(item, hours);
  mine = claims.find(claim => claim.run === run);
  if (mine === undefined) throw new Error('claim: this run\'s claim is not on the item after posting it');
}

const holder = claims[0];
if (holder.id === mine.id) {
  emit({ held: 'true', holder: run, reason: `run ${run} holds ${target || pr}` });
} else {
  editComment(item, mine.id, `Loop claim withdrawn: run ${run} (run ${holder.run} claimed this item first).`);
  emit({
    held: 'false',
    holder: holder.run,
    reason: `run ${holder.run} claimed ${target || pr} first; this run does no work this lap`,
  });
}
