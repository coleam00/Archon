import {
  registerDestroyTests,
  registerFinalizeTests,
  registerResumeTests,
  registerSuspendTests,
} from './__tests__/container-lifecycle';
import {
  registerArtifactsMountTests,
  registerSourceMountTests,
} from './__tests__/container-mounts';
import { registerOverlayTests, registerPrepareTests } from './__tests__/container-prepare';

registerOverlayTests();
registerPrepareTests();
registerDestroyTests();
registerSuspendTests();
registerResumeTests();
registerFinalizeTests();
registerSourceMountTests();
registerArtifactsMountTests();
