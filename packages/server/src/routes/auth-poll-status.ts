/**
 * Maps a terminal device-flow error code (from `pollDeviceFlowOnce`) to the
 * client-visible poll status returned by `POST /api/auth/github/device/poll`.
 *
 * The web UI branches on this to show an actionable message — `expired` →
 * "code expired, start again", `denied` → "you declined authorization" — rather
 * than a generic error. Extracted so the mapping is unit-testable without
 * constructing the full app.
 */
export function mapDeviceFlowErrorToPollStatus(code: string): 'expired' | 'denied' | 'error' {
  if (code === 'expired_token') return 'expired';
  if (code === 'access_denied') return 'denied';
  return 'error';
}
