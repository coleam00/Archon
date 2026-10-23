/**
 * Anonymous PostHog usage metrics. README.md owns the event/property inventory.
 * A random install UUID lives at `${ARCHON_HOME}/telemetry-id`; no user identity,
 * code, prompts, message content, paths, custom workflow names or error text is sent.
 * Run references hash the install UUID and run id, allowing joins without sending ids.
 * Every event disables person profiles and clears the source IP at ingest.
 *
 * This module is the capture entry for each event. Consent (opt-out, install id,
 * first-run notice) lives in `telemetry-consent.ts`, event building in
 * `telemetry-events.ts`, and sending in `telemetry-transport.ts`. Every capture
 * is fire-and-forget: it never awaits and never throws.
 */
import {
  isTelemetryDisabled,
  maybeShowFirstRunNotice,
  resetConsentForTests,
} from './telemetry-consent';
import {
  archonSurfaceEventProperties,
  chatTurnEventProperties,
  TELEMETRY_SCHEMA_VERSION,
  WORKFLOW_TERMINAL_EVENT_TYPE,
  workflowInvokedEventProperties,
  workflowTerminalEventProperties,
} from './telemetry-events';
import type {
  ArchonStartedProperties,
  ChatTurnProperties,
  WorkflowInvokedProperties,
  WorkflowTerminalProperties,
} from './telemetry-events';
import { resetTransportForTests, sendEvent } from './telemetry-transport';

/**
 * Capture a `workflow_invoked` event. Safe to call from hot paths. Shows the
 * first-run notice on first invocation when telemetry is enabled and stderr is
 * interactive.
 */
export function captureWorkflowInvoked(props: WorkflowInvokedProperties): void {
  if (isTelemetryDisabled()) return;
  maybeShowFirstRunNotice();
  sendEvent('workflow_invoked', () => workflowInvokedEventProperties(props));
}

/**
 * Capture an `archon_started` event. Call once per CLI invocation and per server
 * boot (the single call sites in `cli.ts` / the server entrypoint enforce that —
 * there is no in-function dedup guard; the CLI leaves `serve` and detached run
 * owners to the process that reports them). This (not just `workflow_invoked`) is
 * what makes active-install / DAU metrics honest, since users who only run
 * `doctor`/`serve`/chat would otherwise be invisible. Machine context rides
 * along via the registered super-properties. Also shows the first-run notice.
 */
export function captureArchonStarted(props: ArchonStartedProperties): void {
  if (isTelemetryDisabled()) return;
  maybeShowFirstRunNotice();
  sendEvent('archon_started', () => archonSurfaceEventProperties(props));
}

/**
 * Capture an `archon_active` heartbeat. Long-running servers emit
 * `archon_started` once per boot and then go silent, which would make a
 * server-only install drop out of active-install (DAU/WAU) metrics after day one.
 * The server entrypoint calls this on a daily interval so "active installs"
 * stays honest for the server surface. CLI invocations do NOT need this — each
 * one already emits `archon_started`. Carries the same categorical properties as
 * `archon_started`. Intentionally does not show the first-run notice (heartbeats
 * are background, never interactive).
 */
export function captureArchonActive(props: ArchonStartedProperties): void {
  if (isTelemetryDisabled()) return;
  sendEvent('archon_active', () => archonSurfaceEventProperties(props));
}

/** Agent-reported no-fit decisions only; no request text or workflow names leave the install. */
export function captureWorkflowNoMatch(transport: 'native_tool' | 'cli'): void {
  if (isTelemetryDisabled()) return;
  sendEvent('workflow_no_match', () => ({ schema_version: TELEMETRY_SCHEMA_VERSION, transport }));
}

/**
 * Capture a `chat_turn_handled` event — one per direct-chat AI turn across all
 * platforms (slack/telegram/discord/github/web/cli). Workflow runs are excluded
 * by construction (they emit `workflow_invoked` from the executor instead; the
 * orchestrator capture sites sit on the chat-only completion paths). Carries
 * platform + provider + outcome only — never message content or conversation ids.
 */
export function captureChatTurn(props: ChatTurnProperties): void {
  if (isTelemetryDisabled()) return;
  sendEvent('chat_turn_handled', () => chatTurnEventProperties(props));
}

/**
 * Capture a `workflow_approval_resolved` event — one per human approve/reject
 * decision at an approval gate, across every surface (chat command, CLI, web API,
 * Slack buttons, manage_run tool, natural language). Carries ONLY the binary
 * resolution — no run ids, workflow names, comments, or rejection reasons.
 */
export function captureApprovalResolved(props: { resolution: 'approved' | 'rejected' }): void {
  if (isTelemetryDisabled()) return;
  sendEvent('workflow_approval_resolved', () => ({
    resolution: props.resolution,
    schema_version: TELEMETRY_SCHEMA_VERSION,
  }));
}

/**
 * Capture a `codebase_registered` event — a pure count (no name, path, or remote
 * URL ever) emitted when a new codebase row is created. Together with
 * `archon_started` this gives the activation funnel: installed → registered a
 * project → first workflow run.
 */
export function captureCodebaseRegistered(): void {
  if (isTelemetryDisabled()) return;
  sendEvent('codebase_registered', () => ({ schema_version: TELEMETRY_SCHEMA_VERSION }));
}

/**
 * Capture a terminal workflow run. Intentionally does not show the first-run
 * notice (that fires on start events, not completion).
 */
export function captureWorkflowTerminal(props: WorkflowTerminalProperties): void {
  if (isTelemetryDisabled()) return;
  sendEvent(WORKFLOW_TERMINAL_EVENT_TYPE[props.outcome], () =>
    workflowTerminalEventProperties(props)
  );
}

/**
 * Reset internal state for tests. Not part of the public API.
 * @internal
 */
export function resetTelemetryForTests(): void {
  resetConsentForTests();
  resetTransportForTests();
}
