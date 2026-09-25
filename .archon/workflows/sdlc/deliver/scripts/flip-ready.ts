/**
 * The ready flip: the one irreversible step, so it re-verifies CI itself instead of
 * trusting the loop above. It reads through the pack's check reader (`gh` by
 * default, `archon forge checks` with `ARCHON_SDLC_FORGE=forge`) and refuses any
 * pending, red, gated or unknown check, and any failed read: a failed observation
 * is not evidence that no CI exists. Both the read and the flip target the recorded
 * qualified pull request, never the checkout's remote, and both go through the
 * source the run selected.
 *
 * A pull request that is already merged needs no flip and is reported as such; one
 * that is closed without a merge has no delivery to report and refuses.
 */
import { atRevision, describeUnits, gateState, readPrChecks } from '../../.shared/checks.ts';
import { forgeSource, parseQualifiedPr, type QualifiedPr } from '../../.shared/forge.ts';
import { markPrReady, viewPr } from '../../.shared/pr.ts';
import { emit, note, refuse } from '../../.shared/io.ts';

const boundPr = process.env.INPUTS_PR;
const selected = process.env.ARCHON_SDLC_FORGE;

function preflight(): QualifiedPr | undefined {
  try {
    const pr = parseQualifiedPr(boundPr);
    const read = readPrChecks(pr, selected);
    const state = gateState(read.units);
    if (state !== 'green' && state !== 'none') {
      const notGreen = read.units.filter(unit => unit.state !== 'green');
      throw new Error(
        `refusing to flip with ${state} checks${atRevision(read)}: ${describeUnits(notGreen)}`
      );
    }
    return pr;
  } catch (error) {
    refuse(`flip-ready: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function flipReady(): void {
  const pr = preflight();
  if (pr === undefined) return;
  try {
    const source = forgeSource(selected);
    const observed = viewPr(pr, source).pr;
    if (observed.state === 'merged') {
      note('flip-ready: the PR was already merged, so no flip was needed.');
      emit({ pr_url: observed.url });
      return;
    }
    if (observed.state === 'closed') {
      refuse('flip-ready: the PR is CLOSED without a merge, so there is no delivery to report.');
      return;
    }
    emit({ pr_url: observed.is_draft ? markPrReady(pr, source).url : observed.url });
  } catch (error) {
    refuse(`flip-ready: ${error instanceof Error ? error.message : String(error)}`);
  }
}
flipReady();
