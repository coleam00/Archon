import { expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { captureWorkflowSource } from '@archon/workflows/workflow-source';
import { WORKFLOW_SOURCE_METADATA_KEY } from '@archon/workflows/schemas/workflow-run';
import {
  resourceStartFixtures,
  CONFORMANCE_CODEBASE_ID,
  CONFORMANCE_CONVERSATION_ID,
  type WorkflowStoreHarness,
} from '@archon/workflows/store-conformance';

export async function assertCapturedCapacityAdmission(
  harness: Pick<WorkflowStoreHarness, 'store' | 'reopenStore' | 'clearDeclaredCapacity'>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'captured-capacity-admission-'));
  try {
    const workflows = join(root, 'source', '.archon', 'workflows');
    await mkdir(workflows, { recursive: true });
    const path = join(workflows, 'conformance.yaml');
    const yaml = (capacity: number) =>
      `name: conformance\ndescription: captured capacity\nresource: { name: resource, capacity: ${capacity} }\nnodes:\n  - id: work\n    bash: echo ok\n`;
    await writeFile(path, yaml(1));
    const capture = await captureWorkflowSource({
      sourceRoot: join(root, 'source'),
      captureRoot: join(root, 'capture'),
      sourceConfig: { load_default_workflows: false, load_default_commands: false },
    });
    const { start } = resourceStartFixtures(CONFORMANCE_CODEBASE_ID, CONFORMANCE_CONVERSATION_ID);
    const holder = start();
    const legacy = start();
    legacy.launch.run.metadata[WORKFLOW_SOURCE_METADATA_KEY] = {
      version: 1,
      root: capture.anchor.root,
      origin: capture.origin,
      captured_at: capture.manifest.captured_at,
      digest: capture.manifest.digest,
      file_count: capture.manifest.file_count,
      byte_count: capture.manifest.byte_count,
      source_config: capture.manifest.source_config,
    };
    await harness.store.admitResourceStart(holder);
    expect((await harness.store.admitResourceStart(legacy)).status).toBe('queued');
    await harness.clearDeclaredCapacity(legacy.launch.run.id);
    await writeFile(path, yaml(9));
    const store = await harness.reopenStore();
    expect(await store.drainResourceStarts({ resource: 'resource', hostId: 'host' })).toEqual([]);
    expect((await store.getResourceStartRequest(legacy.launch.run.id))?.status).toBe('queued');
    await store.cancelWorkflowRun(holder.launch.run.id);
    expect(await store.drainResourceStarts({ resource: 'resource', hostId: 'host' })).toMatchObject(
      [{ runId: legacy.launch.run.id }]
    );
  } finally {
    await removeTempTree(root);
  }
}
