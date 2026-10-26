// @archon-test-isolated
import { describe } from 'bun:test';
import { registerAdoptionTests, setupRoutingTests } from './__tests__/workflow-dispatch-adoption';
import {
  registerGateContinuationTests,
  registerNoProjectTests,
  registerStartNoticesTests,
} from './__tests__/workflow-dispatch-entrypoints';
import { trackTempRoots } from '@archon/paths/test-utils';
import { registerLaunchInputTests } from './__tests__/workflow-dispatch-launch-inputs';
import { registerResumeInputTests } from './__tests__/workflow-dispatch-resume-inputs';
import { registerResumeSelectionTests } from './__tests__/workflow-dispatch-resume-selection';

const trackTempRoot = trackTempRoots();
describe('workflow dispatch routing', () => {
  const fixture = setupRoutingTests();
  registerAdoptionTests(fixture);
  registerResumeSelectionTests(fixture);
  registerLaunchInputTests(fixture);
  registerResumeInputTests(fixture);
});
registerNoProjectTests();
registerStartNoticesTests();
registerGateContinuationTests(trackTempRoot);
