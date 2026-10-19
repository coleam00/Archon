/**
 * Say what the learner did. Bound inputs: INPUTS_ACTION, INPUTS_RATIONALE,
 * INPUTS_CONSOLIDATED and INPUTS_FORGED (`null` when that branch did not run).
 */
import { emit, json, run, text } from '../../.shared/io.ts';

run('learn report', () => {
  const action = text(process.env.INPUTS_ACTION);
  const rationale = text(process.env.INPUTS_RATIONALE);
  const kept = json(process.env.INPUTS_CONSOLIDATED);
  const forged = json(process.env.INPUTS_FORGED) as { installed?: boolean; name?: string; branch?: string; reason?: string } | null;
  let what: string;
  if (action === 'consolidate') {
    what = kept === null ? 'Consolidation did not complete; the memory is unchanged.' : `Memory consolidated to ${String(kept)} lessons.`;
  } else if (action === 'forge') {
    what =
      forged === null
        ? 'The forge did not complete.'
        : forged.installed
          ? `Forged \`${forged.name}\` on branch \`${forged.branch}\`, ready for review.`
          : `The forge ran, and nothing was committed: ${forged.reason ?? 'unknown'}.`;
  } else {
    what = 'No change was worth making.';
  }
  emit({ action, summary: `${what} Why: ${rationale}` });
});
