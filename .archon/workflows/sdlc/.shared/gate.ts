/**
 * The green gate: run success never certifies green — this does, deterministically.
 *
 * The delivery tail asks the question after implementation, after corrections, after
 * the merged tree's project gate, and after the CI fix. The same decision answers it
 * each time. A node that produced a verdict is not a node that passed; the implement
 * loop completes on `done`, blocked declines included, so no spend and no public step
 * happens until this reads the verdict itself.
 *
 * Red is not one thing. A change that breaks a check must never reach a pull request.
 * A check that was already red at the run's starting commit, that failed because the
 * environment did, or whose evidence nobody could read, is not evidence about the
 * change — and reality gets checked again downstream: confirm-ready puts the PR back
 * in draft while its real CI is not green. So this fails on `introduced` and lets the
 * causes in `PASSES_RED` through with the claim recorded.
 *
 * A validation that did not finish (`incomplete`) is not red at all. It fails too,
 * since an unfinished gate is no verdict, but it says so and names resuming the run.
 *
 * The record is the node's own result, kept by the engine as a `green-gate` typed
 * artifact, so every later reader — the pull-request body, the terminal report, and
 * the merged-tree check in archon-pr — finds it by type. A clean green also records
 * the commit it certified (`head`, null when the checkout was dirty), which is what
 * lets a later step cite it instead of running the same gate on the same tree again.
 */

import { cleanStartCommit } from './checkout.ts';
import { emit, note, refuse } from './io.ts';
import { passesRed, unfinishedValidation } from './verdict.ts';

export interface GateInput {
  readonly green: string;
  readonly cause: string;
  readonly summary: string;
  readonly stage: string;
}

/** Why the gate refuses this verdict, or undefined when it passes. */
export function gateRefusal({ green, cause, summary, stage }: GateInput): string | undefined {
  if (cause === 'incomplete') {
    // Decided before `green` is read: a green over checks that never ran is unsupported.
    return unfinishedValidation(stage, summary);
  }
  if (green === 'true') return undefined;
  if (cause === '') {
    // No cause and no check run: the declaring node stopped on a blocker and said why.
    return summary === ''
      ? `${stage} is red and declared no red_cause. Red that nobody explained is red this gate refuses.`
      : `${stage} stopped on a blocker it declared: ${summary}`;
  }
  if (!passesRed(cause)) {
    return (
      `${stage} is red (${cause}). ` +
      (cause === 'interaction'
        ? `The separately green changes fail when composed; hold this combination. ${summary} `
        : 'The change has no accepted non-introduced-red evidence. ') +
      'Refusing to open or advance a pull request on red work.'
    );
  }
  if (summary === '') {
    // The label is not the claim. Emptiness is all this checks; whether the prose is
    // genuine evidence is the declaring agent's judgment and the reviewer's.
    return (
      `${stage} declared its red ${cause}, but recorded no evidence for the claim. ` +
      'A pass on red the change did not cause is only as good as the failing check ' +
      'it names — refusing without it.'
    );
  }
  return undefined;
}

export function greenGate(input: GateInput): void {
  const { green, cause, summary, stage } = input;
  const refusal = gateRefusal(input);
  if (refusal !== undefined) {
    refuse(refusal);
  } else if (green === 'true') {
    emit({ gate: 'green', red_cause: '', stage, summary: '', head: cleanStartCommit() });
  } else {
    note(
      `${stage} is red, and declared that red ${cause} rather than introduced. ` +
        "Proceeding so the pull request's own CI can be observed; a red conclusion " +
        'requires explicit operator action.'
    );
    emit({ gate: 'green', red_cause: cause, stage, summary, head: null });
  }
}
