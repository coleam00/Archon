import { createLogger } from '@archon/paths';
import { CONTAINER_LABELS } from '../types';
import { dockerCli, type DockerRunner } from './docker-exec';

export const VERIFICATION_IMAGE_RUN_LABEL = 'archon.run_id';
const INSPECT = `{"id":{{json .Id}},"parent":{{json .Parent}},"owner":{{json (index .Config.Labels ${JSON.stringify(VERIFICATION_IMAGE_RUN_LABEL)})}}}`;

interface Image {
  id: string;
  parent: string;
  owner: string;
}

function readImage(stdout: string): Image {
  const value: unknown = JSON.parse(stdout);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    typeof value.id !== 'string' ||
    !value.id.startsWith('sha256:') ||
    !('parent' in value) ||
    typeof value.parent !== 'string' ||
    !('owner' in value) ||
    typeof value.owner !== 'string'
  )
    throw new Error('Incomplete Docker image inspection');
  return { id: value.id, parent: value.parent, owner: value.owner };
}

async function output(runner: DockerRunner, args: string[]): Promise<string> {
  return (await runner(args, { timeout: 15_000 })).stdout.trim();
}

async function inspect(runner: DockerRunner, ref: string): Promise<Image> {
  return readImage(await output(runner, ['image', 'inspect', '--format', INSPECT, ref]));
}

async function inUse(runner: DockerRunner, id: string): Promise<boolean> {
  return Boolean(
    await output(runner, ['container', 'ls', '--all', '--quiet', '--filter', `ancestor=${id}`])
  );
}

async function ownedImages(
  runner: DockerRunner,
  runId: string,
  errors: unknown[]
): Promise<Image[]> {
  const ids = new Set(
    (
      await output(runner, [
        'image',
        'ls',
        '--all',
        '--quiet',
        '--no-trunc',
        '--filter',
        `label=${VERIFICATION_IMAGE_RUN_LABEL}=${runId}`,
      ])
    )
      .split(/\s+/)
      .filter(Boolean)
  );
  const images: Image[] = [];
  for (const id of ids) {
    try {
      const image = await inspect(runner, id);
      if (image.id === id && image.owner === runId) images.push(image);
    } catch (err) {
      errors.push(err);
      createLogger('isolation.verification-images').warn(
        { err, runId, imageId: id },
        'verification_images.inspect_failed'
      );
    }
  }
  return images;
}

// Classic Docker builds expose ancestry; remove owned children before their parents.
function* descendantsFirst(images: Image[]): Generator<Image> {
  const pending = new Map(images.map(image => [image.id, image]));
  while (pending.size) {
    const leaves = [...pending.values()].filter(
      image => ![...pending.values()].some(child => child.parent === image.id)
    );
    if (!leaves.length) throw new Error('Cyclic Docker image ancestry');
    for (const image of leaves) {
      pending.delete(image.id);
      yield image;
    }
  }
}

async function removeImage(runner: DockerRunner, image: Image, runId: string): Promise<void> {
  if (await inUse(runner, image.id)) {
    createLogger('isolation.verification-images').debug(
      { runId, imageId: image.id },
      'verification_images.kept_in_use'
    );
    return;
  }
  // Delete the identity we authorized. A tag can be rebound between inspect and rm.
  // Docker refuses non-forced ID deletion with multiple tags; retain and report it.
  await output(runner, ['image', 'rm', '--no-prune', image.id]);
}

/** Release only this run's unused verification images, without pruning their parents. */
export async function releaseRunVerificationImages(
  runId: string,
  containerEnvId?: string,
  runner: DockerRunner = dockerCli
): Promise<void> {
  if (!runId.trim()) throw new Error('A run ID is required for verification image cleanup');
  const log = createLogger('isolation.verification-images');
  const errors: unknown[] = [];
  try {
    if (
      containerEnvId &&
      (await output(runner, [
        'container',
        'ls',
        '--all',
        '--quiet',
        '--filter',
        `label=${CONTAINER_LABELS.managed}=true`,
        '--filter',
        `label=${CONTAINER_LABELS.envId}=${containerEnvId}`,
      ]))
    ) {
      log.debug({ runId, containerEnvId }, 'verification_images.kept_for_container');
      return;
    }
    for (const image of descendantsFirst(await ownedImages(runner, runId, errors))) {
      try {
        await removeImage(runner, image, runId);
      } catch (err) {
        errors.push(err);
        log.warn({ err, runId, imageId: image.id }, 'verification_images.remove_failed');
      }
    }
  } catch (err) {
    errors.push(err);
    log.warn({ err, runId }, 'verification_images.cleanup_failed');
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      `Verification image cleanup failed for run ${runId}: ${errors.map(String).join('; ')}`
    );
}
