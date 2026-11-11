import { expect, test } from 'bun:test';
import { VERIFICATION_IMAGE_RUN_LABEL } from '../packages/isolation/src/container/verification-images';

test('Slack verification build uses the Docker cleanup ownership label', async () => {
  const script = await Bun.file(new URL('./test-docker-slack-upgrade.sh', import.meta.url)).text();
  expect(script).toContain(
    `verification_build+=(--label "${VERIFICATION_IMAGE_RUN_LABEL}=$WORKFLOW_ID")`
  );
});

test('the variables reference build and recovery commands use the Docker cleanup ownership label', async () => {
  const guide = await Bun.file(
    new URL('../packages/docs-web/src/content/docs/reference/variables.md', import.meta.url)
  ).text();
  expect(guide).toContain(`docker build --label "${VERIFICATION_IMAGE_RUN_LABEL}=$WORKFLOW_ID"`);
  expect(guide).toContain(
    `docker image ls --all --no-trunc --filter "label=${VERIFICATION_IMAGE_RUN_LABEL}=<run-id>"`
  );
});
