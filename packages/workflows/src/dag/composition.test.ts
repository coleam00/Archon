// @archon-test-isolated
import { describe } from 'bun:test';
import {
  registerAuthoredConfigTests,
  registerRuntimeBoundariesTests,
} from './__tests__/composition-execution';
import {
  registerComposedResultTests,
  registerGovernanceTests,
} from './__tests__/composition-governance';
import {
  registerIncludeGateTests,
  registerResultContractTests,
} from './__tests__/composition-include-gates';
import {
  registerIncludeResumeTests,
  setupIncludeExpansionTests,
} from './__tests__/composition-include-resume';

registerResultContractTests();
describe('executeDagWorkflow -- flattened include expansion', () => {
  const fixture = setupIncludeExpansionTests();
  registerIncludeGateTests(fixture);
  registerIncludeResumeTests(fixture);
});
registerAuthoredConfigTests();
registerRuntimeBoundariesTests();
registerGovernanceTests();
registerComposedResultTests();
