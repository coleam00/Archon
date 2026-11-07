import { expect, test } from 'bun:test';
import { VERIFICATION_IMAGE_RUN_LABEL } from '../packages/isolation/src/container/verification-images';

test('Slack verification build uses the Docker cleanup ownership label', async () => {
  const script = await Bun.file(new URL('./test-docker-slack-upgrade.sh', import.meta.url)).text();
  expect(script).toContain(
    `verification_build+=(--label "${VERIFICATION_IMAGE_RUN_LABEL}=$WORKFLOW_ID")`
  );
});

for (const path of [
  '../.archon/workflows/sdlc/README.md',
  '../packages/docs-web/src/content/docs/reference/variables.md',
]) {
  test(`${path} build command uses the Docker cleanup ownership label`, async () => {
    const guide = await Bun.file(new URL(path, import.meta.url)).text();
    expect(guide).toContain(`docker build --label "${VERIFICATION_IMAGE_RUN_LABEL}=$WORKFLOW_ID"`);
  });
}

test('SDLC recovery command uses the Docker cleanup ownership label', async () => {
  const guide = await Bun.file(
    new URL('../.archon/workflows/sdlc/README.md', import.meta.url)
  ).text();
  expect(guide).toContain(
    `docker image ls --all --no-trunc --filter "label=${VERIFICATION_IMAGE_RUN_LABEL}=<run-id>"`
  );
});
