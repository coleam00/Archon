import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { RUN_ARTIFACTS_ENGINE_SUBDIR } from '@archon/paths';
import { writeArtifactFile } from '../artifact-writes';
import { writeNodeArtifact, writeNodeArtifactsListing } from '../artifacts-index';
import type { InvocationListings } from '../invocation-listings';
import { nodeOutcomesListingSchema } from '../schemas/node-outcomes';
import type { DryRunContext } from './context';

export async function writeDryRunInvocationListings(
  ctx: DryRunContext
): Promise<InvocationListings> {
  for (const { source: _source, text, ...recorded } of ctx.typedOutputs) {
    await writeNodeArtifact(ctx.artifactsDir, { ...recorded, runId: 'dry-run' }, text);
  }
  const typedArtifactsFile = await writeNodeArtifactsListing(ctx.artifactsDir, 'dry-run');
  const nodeOutcomesFile = join(
    ctx.artifactsDir,
    RUN_ARTIFACTS_ENGINE_SUBDIR,
    'node-outcomes',
    `${randomUUID()}.json`
  );
  const listing = nodeOutcomesListingSchema.parse({
    run_id: 'dry-run',
    first_failed_node: ctx.nodeOutcomes.find(node => node.state === 'failed')?.node_id ?? null,
    nodes: ctx.nodeOutcomes,
  });
  await writeArtifactFile(nodeOutcomesFile, JSON.stringify(listing, null, 2));
  return { typedArtifactsFile, nodeOutcomesFile };
}
