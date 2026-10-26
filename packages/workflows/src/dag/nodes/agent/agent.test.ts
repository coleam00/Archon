// @archon-test-isolated
import { describe } from 'bun:test';
import {
  registerPromptSubstitutionTests,
  registerToolPromptTests,
} from './__tests__/agent-prompt-boundaries';
import {
  registerCostTests,
  registerProviderEventsTests,
  registerRuntimeSubstitutionTests,
  registerSessionRecordTests,
} from './__tests__/agent-provider-contract';
import { registerQuotaWaitTests, setupCreditExhaustionTests } from './__tests__/agent-quota-waits';
import { registerRateLimitTests } from './__tests__/agent-rate-limits';
import {
  registerStreamingTests,
  registerStructuredOutputTests,
} from './__tests__/agent-structured-output';
import {
  registerToolConfigurationTests,
  setupToolRestrictionsTests,
} from './__tests__/agent-tool-config';

describe('executeDagWorkflow -- tool restrictions', () => {
  const fixture = setupToolRestrictionsTests();
  registerToolConfigurationTests(fixture);
  registerToolPromptTests(fixture);
});
registerPromptSubstitutionTests();
registerStructuredOutputTests();
registerStreamingTests();
registerProviderEventsTests();
describe('executeDagWorkflow -- credit exhaustion', () => {
  const fixture = setupCreditExhaustionTests();
  registerQuotaWaitTests(fixture);
  registerRateLimitTests(fixture);
});
registerCostTests();
registerSessionRecordTests();
registerRuntimeSubstitutionTests();
