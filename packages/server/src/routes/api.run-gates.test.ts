import {
  registerAnswerTests,
  registerExpectedGateTests,
  registerLegacyAttentionTests,
} from './__tests__/api.run-gates-answer';
import {
  registerContinuationTests,
  registerRespondTests,
} from './__tests__/api.run-gates-continuation';
import { registerApproveTests, registerRejectTests } from './__tests__/api.run-gates-decisions';

registerLegacyAttentionTests();
registerAnswerTests();
registerExpectedGateTests();
registerApproveTests();
registerRejectTests();
registerRespondTests();
registerContinuationTests();
