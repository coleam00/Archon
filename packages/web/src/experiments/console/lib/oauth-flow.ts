import type { ProviderOAuthPoll, ProviderOAuthStart } from '../skills';

/**
 * Merge late-arriving OAuth signals from a poll response into the start
 * state. The bridge returns `url`/`userCode` from START only when the
 * provider's first callback fires within start's bounded wait; when a start
 * supersedes a prior session (extra settle latency) the signals arrive via
 * POLL instead — the poll response carries optional `mode`/`url`/`userCode`/
 * `verificationUri` for exactly this case. Ignoring them leaves the manual
 * panel rendered with no authorization link forever (the bug behind the
 * "endless polling, no link" report on the VPS).
 *
 * Returns the same reference when the poll adds nothing new, so callers can
 * use it directly in a state setter without redundant re-renders.
 */
export function mergeOAuthSignals(
  start: ProviderOAuthStart,
  poll: ProviderOAuthPoll
): ProviderOAuthStart {
  const url = start.url ?? poll.url;
  const mode = poll.mode ?? start.mode;
  const userCode = start.userCode ?? poll.userCode;
  const verificationUri = start.verificationUri ?? poll.verificationUri;
  if (
    url === start.url &&
    mode === start.mode &&
    userCode === start.userCode &&
    verificationUri === start.verificationUri
  ) {
    return start;
  }
  return { ...start, url, mode, userCode, verificationUri };
}
