/**
 * The events the GitHub source plugin makes from what it reads to observe an open wait,
 * each with the key that makes it one delivery. Built in a fixed key order, so the same
 * state digests the same on every pass.
 */
import { createHash } from 'node:crypto';
import {
  type CommitChecksObservation,
  type ForgeEvent,
  type PrReviewsObservation,
  settledChecks,
} from '@archon/forge';
import { reviewState } from './normalize-event';

export interface ObservedEvent {
  key: string;
  event: ForgeEvent;
}

/**
 * The `check.changed` event a webhook would have carried for each check on the commit,
 * and, once none is still pending, the `checks.settled` event no webhook carries.
 */
export function commitCheckEvents(observed: CommitChecksObservation): ObservedEvent[] {
  const repo = { host: observed.repo.host, path: observed.repo.path };
  const states = observed.units.map(
    unit => `${unit.unit.kind}:${unit.unit.id}:${unit.phase}:${unit.nativeResult ?? ''}`
  );
  const events: ObservedEvent[] = observed.units.map((unit, index) => ({
    key: `check:${repo.host}/${repo.path}@${observed.revision}:${states[index] ?? ''}`,
    event: {
      kind: 'check.changed',
      action: 'changed',
      repo,
      revision: observed.revision,
      unit: { kind: unit.unit.kind, id: unit.unit.id, name: unit.unit.name },
      nativeState: unit.nativeState,
      phase: unit.phase,
      nativeResult: unit.nativeResult,
      result: unit.result,
      // A check event names no subject; no binding field reads its pull requests.
      pullRequests: [],
    },
  }));
  const result = settledChecks(observed);
  if (result === null) return events;
  // Keyed by each check's outcome, so the same settled state observed again, in any order,
  // is one delivery. A check run counts by its id, so a rerun (new ids on GitHub) settles as
  // a new one. A commit status counts by its case-folded context, as GitHub folds it: a
  // reporter that posts the same result again makes a new status id, not a new state.
  const outcomes = observed.units.map(unit =>
    unit.unit.kind === 'check'
      ? `check:${unit.unit.id}:${unit.nativeResult ?? ''}`
      : `commit_status:${unit.unit.name.toLowerCase()}:${unit.nativeResult ?? ''}`
  );
  const digest = createHash('sha256').update(outcomes.sort().join('\n')).digest('hex');
  events.push({
    key: `checks-settled:${repo.host}/${repo.path}@${observed.revision}:${result}:${digest}`,
    event: { kind: 'checks.settled', action: 'settled', repo, revision: observed.revision, result },
  });
  return events;
}

/** The `review.changed` event a webhook would have carried for each submitted or dismissed review. */
export function reviewEvents(observed: PrReviewsObservation): ObservedEvent[] {
  const pr = {
    repo: { host: observed.ref.repo.host, path: observed.ref.repo.path },
    number: observed.ref.number,
  };
  const events: ObservedEvent[] = [];
  for (const item of observed.items) {
    // A pending review is not submitted yet; a webhook would not have carried it.
    if (item.kind !== 'review' || item.state === null || /^pending$/i.test(item.state)) continue;
    const nativeState = item.state.toLowerCase();
    const action = nativeState === 'dismissed' ? 'dismissed' : 'submitted';
    events.push({
      key: `review:${pr.repo.host}/${pr.repo.path}#${String(pr.number)}:${item.id}:${action}`,
      event: {
        kind: 'review.changed',
        action,
        pr,
        review: {
          id: item.id,
          state: reviewState(nativeState),
          nativeState,
          commit: item.commit,
          author: item.author,
        },
      },
    });
  }
  return events;
}
