import { expect, test } from 'bun:test';
import { VERIFICATION_IMAGE_RUN_LABEL } from '../packages/isolation/src/container/verification-images';

test('Slack verification build uses the Docker cleanup ownership label', async () => {
  const script = await Bun.file(new URL('./test-docker-slack-upgrade.sh', import.meta.url)).text();
  expect(script).toContain(
    `verification_build+=(--label "${VERIFICATION_IMAGE_RUN_LABEL}=$WORKFLOW_ID")`
  );
});
