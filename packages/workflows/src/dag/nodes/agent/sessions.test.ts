// @archon-test-isolated
import { describe } from 'bun:test';
import {
  registerNamedForkTests,
  registerSessionCheckpointTests,
} from './__tests__/sessions-named-forks';
import {
  registerOwnerBranchTests,
  setupAddressableTests,
} from './__tests__/sessions-owner-branches';
import { registerOwnerResumeTests } from './__tests__/sessions-owner-resume';
import { registerPersistenceTests, setupPersistTests } from './__tests__/sessions-persistence';
import { registerProviderThreadingTests } from './__tests__/sessions-provider-threading';
import {
  registerConcurrentPersistTests,
  registerPersistRecoveryTests,
} from './__tests__/sessions-recovery';

describe('executeDagWorkflow -- persist_session', () => {
  const fixture = setupPersistTests();
  registerPersistenceTests(fixture);
  registerPersistRecoveryTests(fixture);
});
registerConcurrentPersistTests();
describe('executeDagWorkflow -- addressable session resume', () => {
  const fixture = setupAddressableTests();
  registerOwnerBranchTests(fixture);
  registerOwnerResumeTests(fixture);
  registerNamedForkTests(fixture);
  registerSessionCheckpointTests(fixture);
});
registerProviderThreadingTests();
