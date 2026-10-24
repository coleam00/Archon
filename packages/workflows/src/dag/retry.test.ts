// @archon-test-isolated
import { registerDeterministicTests } from './__tests__/retry-deterministic';
import { registerTransientTests } from './__tests__/retry-transient';

registerTransientTests();
registerDeterministicTests();
