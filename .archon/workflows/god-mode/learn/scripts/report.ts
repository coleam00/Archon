/**
 * Say what the learner did, and write every class it found to `learn-report.md` in
 * the run's artifacts, ranked as `reflect` ranked them. Bound inputs: INPUTS_ACTION,
 * INPUTS_RATIONALE, INPUTS_CLASSES, and INPUTS_CONSOLIDATED, INPUTS_FORGED and
 * INPUTS_REVISED (`null` when that branch did not run).
 */
import { writeFileSync } from 'node:fs';
import { emit, json, run, text } from '../../.shared/io.ts';

interface FailureClass {
  name: string;
  cost: string;
  evidence: string;
  cause: string;
  fix: string;
}

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
  const classes = (json(process.env.INPUTS_CLASSES) as FailureClass[] | null) ?? [];
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
  const summary = `${what} Why: ${rationale}`;
  const dir = process.env.ARTIFACTS_DIR;
  if (dir) {
    const ranked = classes
      .map((c, i) => `## ${i + 1}. ${c.name}\n\n- **Cost:** ${c.cost}\n- **Evidence:** ${c.evidence}\n- **Cause:** ${c.cause}\n- **Fix:** ${c.fix}`)
      .join('\n\n');
    writeFileSync(`${dir}/learn-report.md`, `# Learner report\n\n${summary}\n\n# Classes found (${classes.length}), most costly first\n\n${ranked || 'none'}\n`);
  }
  emit({ action, summary, classes: classes.length });
});
