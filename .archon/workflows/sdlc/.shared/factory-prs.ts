/**
 * What the PR metrics need from the forge and cannot read yet.
 *
 * `archon-metrics-prs` and `archon-metrics-test-value` record the outcomes of the pull
 * requests the build queue opened, attributed to the runs that built them. Each
 * record needs the pull request's creation, merge and close times, and no forge
 * operation reports them, so both workflows refuse with this operation named.
 */

/** The forge operation the PR metrics need. `pr.view` reports a pull request's state but not when it changed. */
export const PR_TIMESTAMPS = 'pr.view with createdAt, mergedAt and closedAt (or pr.list with a merged-since filter)';
