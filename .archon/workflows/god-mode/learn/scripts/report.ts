/**
 * Say what the learner did. Bound inputs: INPUTS_ACTION, INPUTS_RATIONALE, and
 * INPUTS_CONSOLIDATED, INPUTS_FORGED and INPUTS_REVISED (`null` when that branch did
 * not run).
 */
import { emit, json, run, text } from '../../.shared/io.ts';

interface Published {
  installed?: boolean;
  published?: boolean;
  name?: string;
  pr_url?: string;
  reason?: string;
}

function outcome(label: string, result: Published | null, done: boolean | undefined): string {
  if (result === null) return `The ${label} did not complete.`;
  return done ? `Opened ${result.pr_url} for review.` : `The ${label} ran, and nothing was opened: ${result.reason ?? 'unknown'}.`;
}

run('learn report', () => {
  const action = text(process.env.INPUTS_ACTION);
  const rationale = text(process.env.INPUTS_RATIONALE);
  const kept = json(process.env.INPUTS_CONSOLIDATED);
  const forged = json(process.env.INPUTS_FORGED) as Published | null;
  const revised = json(process.env.INPUTS_REVISED) as Published | null;
  let what: string;
  if (action === 'consolidate') {
    what = kept === null ? 'Consolidation did not complete; the memory is unchanged.' : `Memory consolidated to ${String(kept)} lessons.`;
  } else if (action === 'forge') {
    what = outcome('forge', forged, forged?.installed);
  } else if (action === 'revise') {
    what = outcome('revision', revised, revised?.published);
  } else {
    what = 'No change was worth making.';
  }
  emit({ action, summary: `${what} Why: ${rationale}` });
});
