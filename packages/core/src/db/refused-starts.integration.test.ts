// @archon-test-isolated
/**
 * A start no run caused (a fire, a schedule, a webhook, a label) that is refused records why
 * on its binding row, and attention lists it while it is its item's newest step.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { observesItemMetadata } from '@archon/workflows/schemas/run-metadata';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { listAttentionQueue } from '@archon/workflows/attention-queue';
import { resourceStartFixtures } from '@archon/workflows/store-conformance';
import type { ResourceStartBindingIntent } from '@archon/workflows/schemas/resource-start';
import { RUN_ENDED_SOURCE_ACTOR } from '@archon/workflows/schemas/resource-start';
import { closeDatabase, getDatabase, resetDatabase } from './connection';
import { createWorkflowStore } from '../workflows/store-adapter';
import { attentionQueueSource } from '../operations/attention-queue';

const USER_ID = '22222222-2222-4222-8222-222222222222';
const CODEBASE_ID = '33333333-3333-4333-8333-333333333333';
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const originalArchonHome = process.env.ARCHON_HOME;
const originalDatabaseUrl = process.env.DATABASE_URL;
let root = '';

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'archon-refused-starts-')));
  process.env.ARCHON_HOME = root;
  delete process.env.DATABASE_URL;
  resetDatabase();
  await getDatabase().query(
    `INSERT INTO remote_agent_users (id, display_name) VALUES ($1, 'Test')`,
    [USER_ID]
  );
  await getDatabase().query(
    `INSERT INTO remote_agent_codebases (id, name, default_cwd, ai_assistant_type) VALUES ($1, 'project', $2, 'claude')`,
    [CODEBASE_ID, root]
  );
});

afterEach(async () => {
  await closeDatabase();
  if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalArchonHome;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  await removeTempTree(root);
});

const store = () => createWorkflowStore();
const { launch } = resourceStartFixtures(CODEBASE_ID, CONVERSATION_ID);

function intent(extra: Partial<ResourceStartBindingIntent> = {}): ResourceStartBindingIntent {
  return {
    bindingId: 'build',
    bindingRevision: null,
    hostId: 'host',
    runAsUserId: USER_ID,
    resource: 'pool',
    capacity: 5,
    overlap: 'queue',
    launch: { cwd: root, workflowName: 'build', inputs: {}, isolation: { kind: 'in-place' } },
    ...extra,
  };
}

/** A receipt of one binding on `issue-1`, claimed for preparation; a fire's unless `actor`. */
async function claimed(binding: ResourceStartBindingIntent, actor: unknown = null) {
  const receiptId = crypto.randomUUID();
  await store().acceptStartReceipt({
    receipt: {
      id: receiptId,
      sourceInstanceId: 'source',
      deliveryId: null,
      contentDigest: receiptId,
      receivedAt: new Date().toISOString(),
      occurredAt: null,
      sourceActor: actor as null,
      itemKey: 'issue-1',
    },
    outcome: 'matched',
    bindings: [binding],
  });
  const identity = { receiptId, bindingId: binding.bindingId, ownerId: crypto.randomUUID() };
  expect(await store().claimStartBindingPreparation(identity)).toBe(true);
  return identity;
}

const refused = async () =>
  (
    await listAttentionQueue(
      attentionQueueSource(store(), { findLatestByCodebaseAndWorkingPath: async () => null })
    )
  ).filter(item => 'kind' in item && item.kind === 'refused_start');

/** Move every run's start a minute later, so it follows a refusal in the same second. */
async function runsLater(): Promise<void> {
  await getDatabase().query(
    "UPDATE remote_agent_workflow_runs SET started_at = datetime(started_at, '+1 minute')"
  );
}

test('a start refused at its limit lists its item with the limit until a run starts on it', async () => {
  const limit = { limit: { name: 'rounds', starts: 1 } };
  const first = await claimed(intent(limit));
  expect(
    await store().completeStartBindingPreparation({ ...first, launch: launch() })
  ).toMatchObject({ status: 'admitted' });
  const second = await claimed(intent(limit));
  expect(
    await store().completeStartBindingPreparation({ ...second, launch: launch() })
  ).toMatchObject({ status: 'refused' });

  expect(await refused()).toEqual([
    expect.objectContaining({
      ref: `refused:${second.receiptId}:build`,
      project: expect.objectContaining({ codebaseId: CODEBASE_ID }),
      item: expect.objectContaining({ key: 'issue-1' }),
      start: expect.objectContaining({
        workflow: 'build',
        itemKey: 'issue-1',
        reason: 'start_limit',
        limit: expect.objectContaining({ name: 'rounds', starts: 1, used: 1, bindingId: 'build' }),
      }),
    }),
  ]);

  // A run that observes the item after the refusal moves nothing on; a step does.
  const shadow = await store().createWorkflowRun({
    workflow_name: 'shadow',
    user_message: '',
    codebase_id: CODEBASE_ID,
    item_key: 'issue-1',
    metadata: observesItemMetadata({ observes: true }),
  });
  await getDatabase().query(
    "UPDATE remote_agent_workflow_runs SET started_at = datetime(started_at, '+1 minute') WHERE id = $1",
    [shadow.id]
  );
  expect(await refused()).toHaveLength(1);
  await store().createWorkflowRun({
    workflow_name: 'build',
    user_message: '',
    codebase_id: CODEBASE_ID,
    item_key: 'issue-1',
  });
  await runsLater();
  expect(await refused()).toEqual([]);
});

test('a start refused in preparation names its reason and detail until the binding starts on the item', async () => {
  const failed = await claimed(intent());
  const fileSetting = { setting: 'policy', path: '/p/docs/policy.md', origin: 'project' } as const;
  await store().failStartBindingPreparation({
    ...failed,
    error: 'launch_preparation_failed',
    retryable: false,
    refusal: 'file_setting_missing',
    fileSetting,
  });
  expect(await refused()).toEqual([
    expect.objectContaining({
      start: expect.objectContaining({ reason: 'file_setting_missing', fileSetting }),
    }),
  ]);

  // The same binding starting on the item later closes it.
  await getDatabase().query(
    "UPDATE remote_agent_start_receipt_bindings SET updated_at = datetime(updated_at, '-1 minute')"
  );
  const next = await claimed(intent());
  await store().completeStartBindingPreparation({ ...next, launch: launch() });
  expect(await refused()).toEqual([]);
});

test('a start a run caused is shown on that run, and a source rejection with no item nowhere', async () => {
  const caused = await claimed(intent(), {
    source: RUN_ENDED_SOURCE_ACTOR,
    id: crypto.randomUUID(),
  });
  await store().failStartBindingPreparation({
    ...caused,
    error: 'launch_preparation_failed',
    retryable: false,
    refusal: 'launch_preparation_failed',
  });
  const receiptId = crypto.randomUUID();
  await store().acceptStartReceipt({
    receipt: {
      id: receiptId,
      sourceInstanceId: 'labels',
      deliveryId: null,
      contentDigest: receiptId,
      receivedAt: new Date().toISOString(),
      occurredAt: null,
      sourceActor: null,
    },
    outcome: 'unmatched',
    bindings: [],
    evaluatedBindings: [
      {
        bindingId: 'triage',
        bindingRevision: null,
        status: 'rejected',
        reason: "Input 'issue': missing",
      },
    ],
  });
  expect(await refused()).toEqual([]);
  // The rejection still records why, for the read that will name it once it has an item.
  const stored = await getDatabase().query<{ refusal: string | null }>(
    'SELECT refusal FROM remote_agent_start_receipt_bindings WHERE receipt_id = $1',
    [receiptId]
  );
  expect(JSON.parse(String(stored.rows[0]?.refusal))).toEqual({ reason: 'rejected_by_source' });
});

test('a source rejection that names its item is listed on it, with no project to read it in', async () => {
  const receiptId = crypto.randomUUID();
  await store().acceptStartReceipt({
    receipt: {
      id: receiptId,
      sourceInstanceId: 'labels',
      deliveryId: 'observe:label:github.com/owner/repo#8:555:triage',
      contentDigest: receiptId,
      receivedAt: new Date().toISOString(),
      occurredAt: null,
      sourceActor: null,
    },
    outcome: 'unmatched',
    bindings: [],
    evaluatedBindings: [
      {
        bindingId: 'triage',
        bindingRevision: null,
        status: 'rejected',
        reason: "Input 'labelId': missing",
        itemKey: 'issue-8',
      },
    ],
  });
  expect(await refused()).toEqual([
    expect.objectContaining({
      ref: `refused:${receiptId}:triage`,
      project: null,
      start: expect.objectContaining({
        itemKey: 'issue-8',
        workflow: null,
        reason: 'rejected_by_source',
      }),
    }),
  ]);
});
