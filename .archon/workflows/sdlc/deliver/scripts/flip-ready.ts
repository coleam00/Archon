/**
 * The ready flip: the one irreversible step, so it re-verifies CI itself instead of
 * trusting the loop above. It reads through the pack's check reader (`gh` by
 * default, `archon forge checks` with `ARCHON_SDLC_FORGE=forge`) and refuses any
 * pending, red, gated or unknown check, and any failed read: a failed observation
 * is not evidence that no CI exists. Both the read and the flip target the recorded
 * qualified pull request, never the checkout's remote. The writes stay on `gh`.
 */
import { atRevision, describeUnits, gateState, readPrChecks } from '../../.shared/checks.ts';
import { parseQualifiedPr, type QualifiedPr } from '../../.shared/forge.ts';
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
  const repo = `${pr.repo.host}/${pr.repo.path}`;
  const number = String(pr.number);

  function gh(...args: string[]): { ok: boolean; stdout: string; stderr: string } {
    const result = Bun.spawnSync(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
    return {
      ok: result.exitCode === 0,
      stdout: result.stdout.toString().trim(),
      stderr: result.stderr.toString().trim(),
    };
  }

  const ready = gh('pr', 'ready', number, '--repo', repo);
  if (ready.ok) {
    const draft = gh('pr', 'view', number, '--repo', repo, '--json', 'isDraft', '--jq', '.isDraft');
    if (!draft.ok) refuse('flip-ready: PR was flipped but its draft state could not be read back.');
    else if (draft.stdout !== 'false')
      refuse('flip-ready: PR still reports draft after the ready flip');
  } else {
    const state = gh('pr', 'view', number, '--repo', repo, '--json', 'state', '--jq', '.state');
    if (state.ok && state.stdout === 'MERGED')
      note('flip-ready: the PR was already merged, so no flip was needed.');
    else if (state.ok && state.stdout === 'CLOSED')
      refuse('flip-ready: the PR is CLOSED without a merge, so there is no delivery to report.');
    else refuse(`flip-ready: the ready flip failed: ${ready.stderr}`);
  }

  if (process.exitCode !== 1) {
    const url = gh('pr', 'view', number, '--repo', repo, '--json', 'url', '--jq', '.url');
    if (!url.ok || url.stdout === '') refuse('flip-ready: the PR URL could not be read back.');
    else emit({ pr_url: url.stdout });
  }
}
flipReady();
