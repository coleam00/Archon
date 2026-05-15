/**
 * Sentinel exception used by the orchestrator-agent to signal "auth refresh
 * succeeded, please retry the same query once" to the upstream caller
 * (handleMessage). Marker only — no payload needed.
 *
 * Why a sentinel and not a return value: the orchestrator's turn handlers
 * (`runStreamingTurn`, `runBatchedTurn`) are deep inside a `for await` loop
 * that consumes the provider's generator. Unwinding via thrown exception is
 * the cleanest way to abort the in-flight turn and retry from scratch with
 * fresh credentials on disk.
 *
 * Behavior spec v2 invariant I-11; research doc §Design recommendation L3.
 *
 * Caller contract:
 *   - Only the orchestrator-agent throws this.
 *   - Only `handleMessage` catches it specifically; one retry is attempted,
 *     then any further error (including a second AuthRefreshedRetryNeeded)
 *     propagates.
 *   - Never exposed to user-facing platform messages — always intercepted
 *     and translated by handleMessage before any platform.sendMessage call.
 */
export class AuthRefreshedRetryNeeded extends Error {
  constructor() {
    super('Auth refresh succeeded; retrying turn with fresh credentials');
    this.name = 'AuthRefreshedRetryNeeded';
  }
}
