export { resourceStartFixtures } from './resource-start-conformance';
export { CONFORMANCE_CODEBASE_ID, CONFORMANCE_CONVERSATION_ID } from './store-conformance/fixtures';
export {
  assertWorkflowClaimRace,
  assertWorkflowEventFeedRace,
  assertWorkflowGateRace,
} from './store-conformance/races';
import { afterEach, beforeEach, describe } from 'bun:test';
import { describeForeignCheckoutAdmission } from './resource-start-conformance';
import type { IWorkflowStore } from './store';
import { describeAdmissionConformance } from './store-conformance/admission';
import { describeAttentionConformance } from './store-conformance/attention';
import { describeEventFeedConformance } from './store-conformance/event-feed';
import { CONFORMANCE_CODEBASE_ID, CONFORMANCE_CONVERSATION_ID } from './store-conformance/fixtures';
import { describeGatesAndTerminalsConformance } from './store-conformance/gates-and-terminals';
import { describeListingConformance } from './store-conformance/listing';
import { describePausesAndWaitsConformance } from './store-conformance/pauses-and-waits';
import { describeResumeReductionConformance } from './store-conformance/resume-reduction';
import { describeRunsAndClaimsConformance } from './store-conformance/runs-and-claims';
import { describeSourceReleaseConformance } from './store-conformance/source-release';
import { describeStartReceiptConformance } from './store-conformance/start-receipts';

export interface WorkflowStoreHarness {
  store: IWorkflowStore;
  seedPersistedWait(runId: string, wait: Record<string, unknown>): Promise<void>;
  backdate(
    runId: string,
    dates: { started_at?: Date; last_activity_at?: Date | null }
  ): Promise<void>;
  /** A snapshot: tests compare it with a later call to prove no report was emitted. */
  terminalReports(): string[];
  close(): Promise<void>;
}

export function describeWorkflowStoreConformance(
  label: string,
  makeHarness: () => Promise<WorkflowStoreHarness>
): void {
  describeForeignCheckoutAdmission(
    label,
    makeHarness,
    CONFORMANCE_CODEBASE_ID,
    CONFORMANCE_CONVERSATION_ID
  );
  describe(`workflow store conformance: ${label}`, () => {
    let harness: WorkflowStoreHarness;
    beforeEach(async () => {
      harness = await makeHarness();
    });
    afterEach(async () => {
      await harness?.close();
    });
    const current = (): WorkflowStoreHarness => harness;

    describeRunsAndClaimsConformance(current);
    describeAdmissionConformance(current);
    describeStartReceiptConformance(current);
    describeEventFeedConformance(current);
    describePausesAndWaitsConformance(current);
    describeSourceReleaseConformance(() => harness.store);
    describeAttentionConformance(current);
    describeGatesAndTerminalsConformance(current);
    describeResumeReductionConformance(current);
    describeListingConformance(current);
  });
}
