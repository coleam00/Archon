/**
 * Named fixture map consumed by the round-trip tests (and, later, PR-2's
 * preview). Each fixture is a wire `WorkflowDefinition` authored already-sparse.
 */
import type { WireWorkflowDefinition } from '../types';
import { loopFixture, loopCommandFixture } from './loop.fixture';
import { approvalFixture } from './approval.fixture';
import { cancelFixture } from './cancel.fixture';
import { scriptFixture } from './script.fixture';
import { mixedFixture } from './mixed.fixture';

export {
  loopFixture,
  loopCommandFixture,
  approvalFixture,
  cancelFixture,
  scriptFixture,
  mixedFixture,
};

/** All builder fixtures keyed by name, for table-driven tests. */
export const FIXTURES: Record<string, WireWorkflowDefinition> = {
  loop: loopFixture,
  loopCommand: loopCommandFixture,
  approval: approvalFixture,
  cancel: cancelFixture,
  script: scriptFixture,
  mixed: mixedFixture,
};
