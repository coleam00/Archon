/**
 * The read-only observations an executable invocation receives: what typed artifacts the
 * run has published (`$TYPED_ARTIFACTS_FILE`) and what each node has recorded so far
 * (`$NODE_OUTCOMES_FILE`). Both are written fresh, at the same moment, before the
 * invocation resolves its text, so a node reads one consistent view of its run.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { RUN_ARTIFACTS_ENGINE_SUBDIR } from '@archon/paths';
import { writeArtifactFile } from './artifact-writes';
import { writeNodeArtifactsListing } from './artifacts-index';
import type { WorkflowRun } from './schemas/workflow-run';
import { NODE_STATE_EVENT_TYPES, type IWorkflowStore } from './store';
import { buildNodeOutcomes } from './terminal-record';

/**
 * Engine-private, beside the typed-artifact listings and inside the run's artifact dir,
 * so a container that mounts that dir reads the same bytes at the same path.
 */
const NODE_OUTCOMES_SUBDIR = join(RUN_ARTIFACTS_ENGINE_SUBDIR, 'node-outcomes');

export interface InvocationListings {
  typedArtifactsFile: string;
  nodeOutcomesFile: string;
}

export interface InvocationListingsSource {
  deps: { store: Pick<IWorkflowStore, 'listEventsForRuns'> };
  artifactsDir: string;
  workflowRun: Pick<WorkflowRun, 'id' | 'metadata'>;
}

/**
 * Write this invocation's observations. Each call writes unique files, so a later
 * observation never overwrites an earlier one. A read or write failure propagates as a
 * provisioning error, never as an empty listing.
 */
export async function writeInvocationListings({
  deps,
  artifactsDir,
  workflowRun,
}: InvocationListingsSource): Promise<InvocationListings> {
  const typedArtifactsFile = await writeNodeArtifactsListing(artifactsDir, workflowRun.id);
  const events =
    (await deps.store.listEventsForRuns([workflowRun.id], NODE_STATE_EVENT_TYPES)).get(
      workflowRun.id
    ) ?? [];
  const nodeOutcomesFile = join(artifactsDir, NODE_OUTCOMES_SUBDIR, `${randomUUID()}.json`);
  await writeArtifactFile(
    nodeOutcomesFile,
    JSON.stringify(buildNodeOutcomes(workflowRun, events), null, 2)
  );
  return { typedArtifactsFile, nodeOutcomesFile };
}
