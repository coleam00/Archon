/**
 * What a paused gate (`awaiting_response`) accepts, and how it is answered: the one owner
 * `ApprovalPanel` and the ask card both read, so they cannot disagree on which decisions a
 * gate offers, what each is called, or which take text.
 */
import type { Run } from '../primitives/run';
import * as skill from '../skills';
import { invalidate } from '../store/cache';

/** One decision a gate offers. */
interface GateChoice {
  id: string;
  label: string;
  /** `approve` takes an optional comment; every other decision requires its reason. */
  text: 'optional' | 'required';
}

/** A decision's words: its authored label, else its id capitalised. */
function decisionLabel(id: string, label: string | undefined): string {
  if (label !== undefined && label.length > 0) return label;
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * The approve decision's words. A signal-bearing interactive-loop gate (#2074) finalizes on a
 * bare approve ("Accept & complete") and runs another iteration when a comment comes with it
 * ("Continue"); an authored gate reads its own label.
 */
export function approveLabel(run: Run, comment: string): string {
  const approval = run.approval;
  if (approval?.decisionsAuthored === true)
    return decisionLabel('approve', approval.decisions?.find(d => d.id === 'approve')?.label);
  return approval?.completionSignaled === true && comment.trim().length === 0
    ? 'Accept & complete'
    : 'Continue';
}

/**
 * The decisions the gate declared (#2707 step 2), approve first when it offers one: an
 * ordinary gate offers approve and reject; one that wrote `approval.decisions:` offers those.
 * `comment` is the text typed so far, which names the signal-bearing approve.
 */
export function gateChoices(run: Run, comment = ''): GateChoice[] {
  const authored = run.approval?.decisionsAuthored === true;
  const decisions = run.approval?.decisions ?? [];
  const canApprove = !authored || decisions.some(d => d.id === 'approve');
  const approve: GateChoice[] = canApprove
    ? [{ id: 'approve', label: approveLabel(run, comment), text: 'optional' }]
    : [];
  return [
    ...approve,
    ...decisions
      .filter(d => d.id !== 'approve')
      .map(d => ({ id: d.id, label: decisionLabel(d.id, d.label), text: 'required' as const })),
  ];
}

/**
 * Answer a paused gate with `decision`, at the pause the run reports, so the server refuses
 * an answer meant for an earlier one. Throws the server's refusal. Every `runs` key and the
 * run's own key refresh on success; a demo run (id `demo-…`) never reaches the server.
 */
export async function respondToGate(run: Run, decision: string, text: string): Promise<void> {
  const trimmed = text.trim();
  if (run.id.startsWith('demo-')) {
    await new Promise<void>(resolve => setTimeout(resolve, 300));
  } else {
    await skill.respondRun(
      run.id,
      decision,
      trimmed.length > 0 ? trimmed : undefined,
      run.approval?.pauseId === undefined
        ? undefined
        : { nodeId: run.approval.nodeId, pauseId: run.approval.pauseId }
    );
  }
  invalidate('runs');
  invalidate(`run:${run.id}`);
}
