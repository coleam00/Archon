import { z } from 'zod';
import { assertCapturedCapacityAdmission } from './resource-capacity-test-fixture';
import { createFileWorkflowStore } from '@archon/workflows/file-store';
import { commit } from '@archon/workflows/file-store';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { captureWorkflowSource } from '@archon/workflows/workflow-source';
import { WORKFLOW_SOURCE_METADATA_KEY } from '@archon/workflows/schemas/workflow-run';
import {
  resourceStartFixtures,
  CONFORMANCE_CODEBASE_ID,
  CONFORMANCE_CONVERSATION_ID,
} from '@archon/workflows/store-conformance';
import { installResourceCapacityPolicy } from './resource-capacity';

const roots = trackTempRoots();
test('legacy declaration recovery reads the verified selected capture, not live workflow files', async () => {
  const root = roots(await mkdtemp(join(tmpdir(), 'legacy-resource-source-')));
  const source = join(root, 'source');
  const workflows = join(source, '.archon', 'workflows');
  await mkdir(workflows, { recursive: true });
  const path = join(workflows, 'conformance.yaml');
  await writeFile(
    path,
    'name: conformance\ndescription: capacity fixture\nresource: { name: build, capacity: 2 }\nnodes:\n  - id: work\n    bash: echo ok\n'
  );
  const capture = await captureWorkflowSource({
    sourceRoot: source,
    captureRoot: join(root, 'capture'),
    sourceConfig: { load_default_workflows: false, load_default_commands: false },
  });
  const { launch } = resourceStartFixtures(CONFORMANCE_CODEBASE_ID, CONFORMANCE_CONVERSATION_ID);
  const prepared = launch();
  prepared.run.metadata[WORKFLOW_SOURCE_METADATA_KEY] = {
    version: 1,
    root: capture.anchor.root,
    origin: capture.origin,
    captured_at: capture.manifest.captured_at,
    digest: capture.manifest.digest,
    file_count: capture.manifest.file_count,
    byte_count: capture.manifest.byte_count,
    source_config: capture.manifest.source_config,
  };
  await writeFile(
    path,
    'name: conformance\ndescription: capacity fixture\nresource: { name: build, capacity: 9 }\nnodes:\n  - id: work\n    bash: echo changed\n'
  );
  const read = installResourceCapacityPolicy.readCapturedDeclaration;
  if (!read) throw new Error('Missing captured declaration reader');
  expect(await read(prepared, 'build')).toBe(2);
  expect(await read(prepared, 'another')).toBeUndefined();
  await writeFile(
    join(capture.anchor.root, 'project', '.archon', 'workflows', 'conformance.yaml'),
    'altered'
  );
  await expect(read(prepared, 'build')).rejects.toThrow();
});

test('legacy captured source controls real file store admission after reopen', async () => {
  const root = roots(await mkdtemp(join(tmpdir(), 'legacy-file-capacity-')));
  const reopenStore = () =>
    createFileWorkflowStore({
      root,
      resourceCapacityPolicy: {
        readCapturedDeclaration: installResourceCapacityPolicy.readCapturedDeclaration,
      },
    });
  await assertCapturedCapacityAdmission({
    store: await reopenStore(),
    reopenStore,
    clearDeclaredCapacity: id =>
      commit(root, [], async () => {
        const path = `resource/requests/${createHash('sha256').update(id).digest('hex')}.json`;
        const row = z.looseObject({}).parse(JSON.parse(await readFile(join(root, path), 'utf8')));
        delete row.declaredCapacity;
        return { result: undefined, changes: { documents: { [path]: row } } };
      }),
  });
});
