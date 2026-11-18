import { SQL } from 'bun';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  forgeAuditResponse,
  forgeOperationAuditSchema,
  type ForgeResponse,
  type ForgeSubjectRef,
} from '@archon/forge';
import type { ForgeAccessCheck } from '@archon/forge/dispatch';
import type { ItemTrackerConfig } from '@archon/core/config/config-types';
import { closeDatabase, getDatabase, resetDatabase } from '@archon/core/db/connection';
import {
  listItemAsks,
  openItemAsksForCompletedRun,
  withdrawItemAsk,
} from '@archon/core/db/item-asks';
import { recordItemRuling, withdrawItemRuling } from '@archon/core/db/item-rulings';
import { ensureItemInProject } from '@archon/core/db/items';
import { createWorkflowRun } from '@archon/core/db/workflows';
import { claimTrackerPass, releaseTrackerPass } from '@archon/core/db/item-tracker';
import { insertWorkflowEvent, listAttentionNotices } from '@archon/core/db/workflow-events';
import { currentProcessOwner } from '@archon/paths/process-owner';
import { removeTempTree } from '@archon/paths/test-utils';
import { ItemTracker, type ItemTrackerForge } from './item-tracker';
import { ITEM_STATUS_MARKER } from './item-tracker-render';

let root: string;
let savedHome: string | undefined;
let savedDatabase: string | undefined;
const postgresUrl = process.env.ARCHON_TEST_PG_URL;
let postgresAdmin: SQL | undefined;
let scratchDatabase: string | undefined;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'archon-item-tracker-test-'));
  savedHome = process.env.ARCHON_HOME;
  savedDatabase = process.env.DATABASE_URL;
  process.env.ARCHON_HOME = root;
  process.env.DATABASE_URL = '';
  if (postgresUrl) {
    postgresAdmin = new SQL(postgresUrl);
    scratchDatabase = `archon_tracker_${crypto.randomUUID().replaceAll('-', '')}`;
    await postgresAdmin.unsafe(`CREATE DATABASE "${scratchDatabase}"`);
    const url = new URL(postgresUrl);
    url.pathname = `/${scratchDatabase}`;
    process.env.DATABASE_URL = url.toString();
  }
  resetDatabase();
});
afterEach(async () => {
  await closeDatabase();
  if (postgresAdmin && scratchDatabase) {
    try {
      await postgresAdmin.unsafe(`DROP DATABASE "${scratchDatabase}" WITH (FORCE)`);
    } finally {
      await postgresAdmin.close();
      postgresAdmin = undefined;
      scratchDatabase = undefined;
    }
  }
  if (savedHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = savedHome;
  if (savedDatabase === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabase;
  await removeTempTree(root);
});

const PROJECT = 'acme/widgets';
const repo = { host: 'github.com', path: 'acme/widgets' };
const trackerConfig = (includeUsage = false): ItemTrackerConfig => ({
  includeUsage,
  projects: [{ project: PROJECT, repo, keys: [{ prefix: 'issue-', kind: 'issue' }] }],
});

type Upsert = Parameters<ItemTrackerForge['upsertComment']>[0];

/**
 * A forge plugin that keeps comments per subject and marker, as `workitem.comment.upsert`
 * does: a new marker posts a comment, a known one edits it. `failNext` answers the next
 * write with a failure instead.
 */
function fakeForge(
  check: ForgeAccessCheck = {
    ok: true,
    host: 'github.com',
    plugin: { name: 'fake', version: '1' },
    read: false,
  }
) {
  const comments = new Map<string, { body: string; posts: number; edits: number }>();
  const calls: Upsert[] = [];
  const checks: string[] = [];
  let failNext: Extract<ForgeResponse, { ok: false }> | undefined;
  const forge: ItemTrackerForge = {
    check: async ({ host }) => {
      checks.push(host);
      return check;
    },
    upsertComment: async request => {
      calls.push(request);
      if (failNext) {
        const failure = { ...failNext, operationId: request.operationId };
        failNext = undefined;
        return failure;
      }
      const key = commentKey(request.subject, request.marker);
      const existing = comments.get(key);
      const changed = existing?.body !== request.body;
      if (existing) {
        existing.edits += changed ? 1 : 0;
        existing.body = request.body;
      } else comments.set(key, { body: request.body, posts: 1, edits: 0 });
      return {
        operationId: request.operationId,
        ok: true,
        result: {
          op: 'workitem.comment.upsert',
          value: {
            target: request.subject.ref,
            outcome: 'applied',
            changed,
            workitem: {
              ...request.subject,
              url: `https://github.com/acme/widgets/issues/${String(request.subject.ref.number)}`,
              state: 'open',
            },
            comment: {
              ref: request.subject.ref,
              id: key,
              url: 'https://github.com/acme/widgets/issues/7#issuecomment-1',
              bodyDigest: 'digest',
            },
          },
        },
      };
    },
  };
  return {
    forge,
    comments,
    calls,
    checks,
    fail(response: Extract<ForgeResponse, { ok: false }>): void {
      failNext = response;
    },
    status(number = 7): { body: string; posts: number; edits: number } | undefined {
      return comments.get(commentKey({ kind: 'issue', ref: { repo, number } }, ITEM_STATUS_MARKER));
    },
  };
}

function commentKey(subject: ForgeSubjectRef, marker: string): string {
  return `${subject.kind}:${String(subject.ref.number)}|${marker}`;
}

async function startRun(itemKey: string, workflow: string): Promise<string> {
  const run = await createWorkflowRun({
    workflow_name: workflow,
    user_message: 'private input',
  });
  const itemId = await ensureItemInProject(
    getDatabase().query.bind(getDatabase()),
    PROJECT,
    itemKey
  );
  await getDatabase().query(
    "UPDATE remote_agent_workflow_runs SET item_id = $1, status = 'running', working_path = $2 WHERE id = $3",
    [itemId, '/Users/private/checkout', run.id]
  );
  return run.id;
}

async function endRun(
  runId: string,
  status: 'completed' | 'failed' | 'running' | 'paused',
  outcome: string | null = null,
  metadata: Record<string, unknown> = {},
  endedAt: Date = new Date()
): Promise<void> {
  const ended = status === 'completed' || status === 'failed' ? endedAt.toISOString() : null;
  await getDatabase().query(
    'UPDATE remote_agent_workflow_runs SET status = $1, completed_outcome = $2, metadata = $3, completed_at = $4 WHERE id = $5',
    [status, outcome, JSON.stringify(metadata), ended, runId]
  );
}

/** Resume an ended run as the engine does: back to running, with a `workflow_resumed` event. */
async function resumeRun(runId: string): Promise<void> {
  await endRun(runId, 'running');
  await insertWorkflowEvent(getDatabase().query.bind(getDatabase()), {
    workflow_run_id: runId,
    event_type: 'workflow_resumed',
  });
}

async function recordPullRequest(runId: string, number: number): Promise<void> {
  const prRef = { repo, number };
  const audit = forgeOperationAuditSchema.parse({
    operationId: crypto.randomUUID(),
    operation: 'pr.create',
    target: prRef,
    plugin: { name: 'fake', version: '1' },
    retries: 0,
    durationMs: 1,
    result: forgeAuditResponse({
      operationId: 'op',
      ok: true,
      result: {
        op: 'pr.create',
        value: {
          target: repo,
          outcome: 'applied',
          changed: true,
          pr: {
            ...prRef,
            schemaVersion: 1,
            url: `https://github.com/acme/widgets/pull/${String(number)}`,
            head: 'feature',
            base: 'dev',
            is_draft: false,
            state: 'open',
            head_repo: repo,
            head_revision: 'a'.repeat(40),
            base_revision: 'b'.repeat(40),
            maintainer_can_modify: true,
          },
        },
      },
    }),
  });
  await insertWorkflowEvent(getDatabase().query.bind(getDatabase()), {
    workflow_run_id: runId,
    event_type: 'integration_operation',
    data: { integration: 'forge', ...audit },
  });
}

/** The ledger rows recording a write, without the baseline rows that record none. */
async function shownRows(runId: string): Promise<unknown[]> {
  return (await listAttentionNotices([runId])).filter(row => row.data.baseline !== true);
}

async function activeTracker(
  forge: ItemTrackerForge,
  config = trackerConfig()
): Promise<ItemTracker> {
  const tracker = new ItemTracker(config, forge);
  await tracker.activate();
  return tracker;
}

test('one status comment, edited in place, shows every stage outcome and the proposed change', async () => {
  const fake = fakeForge();
  const tracker = await activeTracker(fake.forge);
  const plan = await startRun('issue-7', 'plan');
  await tracker.scan();
  expect(fake.status()?.body).toContain('**Archon** is working on this item.');
  expect(fake.status()?.body).toContain('| plan | in progress |  |');

  await endRun(plan, 'completed', 'ready');
  await tracker.scan();
  const implement = await startRun('issue-7', 'implement');
  await tracker.scan();
  await recordPullRequest(implement, 12);
  await endRun(implement, 'completed', 'delivered');
  const review = await startRun('issue-7', 'review');
  await endRun(review, 'failed');
  await tracker.scan();
  // Settled: nothing changed, so another scan writes nothing.
  const writes = fake.calls.length;
  await tracker.scan();
  expect(fake.calls.length).toBe(writes);

  expect([...fake.comments.keys()].filter(key => key.endsWith(ITEM_STATUS_MARKER))).toEqual([
    `issue:7|${ITEM_STATUS_MARKER}`,
  ]);
  const status = fake.status();
  expect(status?.posts).toBe(1);
  expect(
    status?.body.split('\n').filter(line => /^\| (plan|implement|review) /.test(line))
  ).toEqual([
    '| plan | completed | ready |',
    '| implement | completed | delivered |',
    '| review | failed |  |',
  ]);
  expect(status?.body).toContain('**Archon** has no stage in progress on this item.');
  expect(status?.body).toContain('Proposed change: https://github.com/acme/widgets/pull/12');
  expect(status?.body).not.toContain('private');
});

test('a run that ends and then resumes shows in progress again, and its second end is shown', async () => {
  const fake = fakeForge();
  const tracker = await activeTracker(fake.forge);
  const run = await startRun('issue-7', 'implement');
  await endRun(run, 'failed');
  await tracker.scan();
  expect(fake.status()?.body).toContain('| implement | failed |');
  await resumeRun(run);
  await tracker.scan();
  expect(fake.status()?.body).toContain('| implement | in progress |');
  await endRun(run, 'completed', 'delivered');
  await tracker.scan();
  expect(fake.status()?.body).toContain('| implement | completed | delivered |');
});

test('an item with no tracker reference gets nothing, and its ended runs are not reread', async () => {
  const fake = fakeForge();
  const tracker = await activeTracker(fake.forge);
  for (const key of ['task-7', 'issue-07', 'issue-7a', 'issue-']) {
    const run = await startRun(key, 'plan');
    await tracker.scan();
    await endRun(run, 'completed', 'ready');
    await tracker.scan();
  }
  expect(fake.calls).toEqual([]);
  const terminalRows = async (): Promise<number> =>
    (
      await getDatabase().query(
        "SELECT id FROM remote_agent_workflow_events WHERE event_type = 'attention_notice_sent'"
      )
    ).rows.length;
  const settled = await terminalRows();
  // A terminal and a result row per run.
  expect(settled).toBe(8);
  await tracker.scan();
  expect(await terminalRows()).toBe(settled);
});

test('a plugin without the comment operation is reported once and nothing is written', async () => {
  const fake = fakeForge({
    ok: false,
    error: {
      kind: 'unsupported_op',
      message: 'plugin fake does not support workitem.comment.upsert',
    },
    unsupported: ['workitem.comment.upsert'],
  });
  const tracker = await activeTracker(fake.forge);
  await startRun('issue-7', 'plan');
  expect(await tracker.scan()).toEqual([
    {
      project: PROJECT,
      outcome: 'misconfigured',
      errorKind: 'unsupported_op',
      unsupported: ['workitem.comment.upsert'],
    },
  ]);
  await tracker.scan();
  await tracker.scan();
  expect(fake.checks).toEqual(['github.com']);
  expect(fake.calls).toEqual([]);
  expect(tracker.health()).toEqual([{ id: 'tracker:acme/widgets', state: 'misconfigured' }]);
});

test('turning the tracker on writes nothing for work that ended before', async () => {
  const fake = fakeForge();
  for (const number of [7, 8]) {
    const run = await startRun(`issue-${String(number)}`, 'plan');
    await endRun(run, 'completed', 'ready');
  }
  const tracker = await activeTracker(fake.forge);
  expect(tracker.health()).toEqual([{ id: 'tracker:acme/widgets', state: 'active' }]);
  await tracker.scan();
  expect(fake.calls).toEqual([]);
  // A restart does not baseline again: a run that ended while the server was down is shown.
  const later = await startRun('issue-8', 'implement');
  await endRun(later, 'completed', 'delivered');
  await (await activeTracker(fake.forge)).scan();
  expect(
    fake.calls
      .filter(call => call.marker === ITEM_STATUS_MARKER)
      .map(call => call.subject.ref.number)
  ).toEqual([8]);
});

test('an unknown write outcome is retried; a refused write is not retried before a restart', async () => {
  const fake = fakeForge();
  const tracker = await activeTracker(fake.forge);
  const run = await startRun('issue-7', 'plan');
  fake.fail({
    operationId: 'op',
    ok: false,
    error: { kind: 'timeout', message: 'timed out' },
    mutation: {
      op: 'workitem.comment.upsert',
      target: { repo, number: 7 },
      outcome: 'outcome_unknown',
    },
  });
  expect(await tracker.scan()).toEqual([
    {
      project: PROJECT,
      outcome: 'scanned',
      posted: [],
      notPosted: [
        { item: 'issue-7', marker: ITEM_STATUS_MARKER, errorKind: 'timeout', retried: true },
      ],
    },
  ]);
  expect(await shownRows(run)).toEqual([]);
  expect(await tracker.scan()).toEqual([
    {
      project: PROJECT,
      outcome: 'scanned',
      posted: [{ item: 'issue-7', marker: ITEM_STATUS_MARKER }],
      notPosted: [],
    },
  ]);
  expect(fake.calls.length).toBe(2);
  expect(fake.status()?.posts).toBe(1);

  const missing = await startRun('issue-404', 'plan');
  fake.fail({
    operationId: 'op',
    ok: false,
    error: { kind: 'not_found', message: 'no such issue' },
    mutation: {
      op: 'workitem.comment.upsert',
      target: { repo, number: 404 },
      outcome: 'refused',
    },
  });
  await tracker.scan();
  const missed = { item: 'issue-404', marker: ITEM_STATUS_MARKER, errorKind: 'not_found' };
  expect(await tracker.scan()).toEqual([
    {
      project: PROJECT,
      outcome: 'scanned',
      posted: [],
      notPosted: [{ ...missed, retried: false }],
    },
  ]);
  expect(fake.calls.filter(call => call.subject.ref.number === 404).length).toBe(1);
  expect(await shownRows(missing)).toEqual([]);
});

test('a pass that fails after posting reports what it posted', async () => {
  const fake = fakeForge();
  // The run is deleted once its status is posted, so recording the write fails the pass.
  const forge: ItemTrackerForge = {
    ...fake.forge,
    upsertComment: async request => {
      const response = await fake.forge.upsertComment(request);
      await getDatabase().query('DELETE FROM remote_agent_workflow_runs WHERE id = $1', [run]);
      return response;
    },
  };
  const tracker = await activeTracker(forge);
  const run = await startRun('issue-7', 'plan');
  expect(await tracker.scan()).toEqual([
    {
      project: PROJECT,
      outcome: 'failed',
      error: expect.any(String),
      posted: [{ item: 'issue-7', marker: ITEM_STATUS_MARKER }],
      notPosted: [],
    },
  ]);
});

test('cost and token counts are written only when usage is turned on', async () => {
  const usage = { total_cost_usd: 1.5, total_tokens_in: 1200, total_tokens_out: 300 };
  for (const includeUsage of [false, true]) {
    const fake = fakeForge();
    const tracker = await activeTracker(fake.forge, trackerConfig(includeUsage));
    const run = await startRun(includeUsage ? 'issue-2' : 'issue-1', 'plan');
    await endRun(run, 'completed', 'ready', usage);
    await tracker.scan();
    const body = [...fake.comments.values()][0]?.body ?? '';
    expect(body.includes('$1.50')).toBe(includeUsage);
    expect(body.includes('1200 in / 300 out')).toBe(includeUsage);
  }
});

/** Comments other than the status comment, in posting order of their first write. */
function newComments(fake: ReturnType<typeof fakeForge>): string[] {
  return [...fake.comments]
    .filter(([key]) => !key.endsWith(ITEM_STATUS_MARKER))
    .map(([, comment]) => comment.body);
}

const act = { via: 'cli', by: { declared: 'Private Person' }, fromRun: null } as const;

async function leaveAsk(runId: string): Promise<void> {
  await getDatabase().withTransaction(query =>
    openItemAsksForCompletedRun(query, runId, [
      {
        question: 'Keep the old flag?',
        context: 'Removing it breaks two scripts.',
        options: [
          { id: 'keep', does: 'Keeps the flag.', cost: 'Two names for one thing.' },
          { id: 'drop', does: 'Removes the flag.', cost: 'Two scripts need edits.' },
        ],
        recommendation: { option: 'drop', why: 'The scripts are ours.' },
        artifacts: [],
      },
    ])
  );
}

async function pauseAtWait(runId: string): Promise<void> {
  await endRun(runId, 'paused', null, {
    wait: {
      kind: 'attention',
      owner: 'node',
      nodeId: 'choose-base',
      pauseId: 'pause-1',
      waitingSince: '2026-11-16T01:00:00.000Z',
      message: 'Which base branch?',
      form: 'select',
      options: [
        { id: 'use-dev', label: 'dev', does: 'Targets dev.' },
        { id: 'use-main', label: 'main' },
      ],
    },
  });
}

/**
 * The end of `endedRunId` matched a run-ended binding whose next stage has no run yet: its
 * preparation is pending, or it is prepared and its start waits in the resource queue.
 * `admitNextStage` ends both, as admission does with the run it creates.
 */
async function recordRunEndedStart(
  endedRunId: string,
  waits: 'preparation' | 'resource' = 'preparation'
): Promise<void> {
  const receiptId = crypto.randomUUID();
  await getDatabase().query(
    `INSERT INTO remote_agent_start_receipts
     (id, source_instance_id, delivery_id, content_digest, received_at, source_actor, outcome)
     VALUES ($1, 'next-stage', $2, 'digest', $3, $4, 'matched')`,
    [
      receiptId,
      endedRunId,
      new Date().toISOString(),
      JSON.stringify({ source: 'archon-run-ended', id: endedRunId }),
    ]
  );
  await getDatabase().query(
    `INSERT INTO remote_agent_start_receipt_bindings (receipt_id, binding_id, preparation_status)
     VALUES ($1, 'next-stage', $2)`,
    [receiptId, waits === 'preparation' ? 'pending' : 'complete']
  );
  if (waits === 'preparation') return;
  await getDatabase().query(
    "INSERT INTO remote_agent_resource_slots (resource_key) VALUES ('builder') ON CONFLICT DO NOTHING"
  );
  await getDatabase().query(
    `INSERT INTO remote_agent_resource_start_requests
     (id, resource_key, host_id, overlap_policy, status, launch, receipt_id, binding_id)
     VALUES ($1, 'builder', 'host', 'queue', 'queued', '{}', $2, 'next-stage')`,
    [crypto.randomUUID(), receiptId]
  );
}

async function admitNextStage(endedRunId: string, itemKey: string, workflow: string) {
  const receipts = 'SELECT id FROM remote_agent_start_receipts WHERE delivery_id = $1';
  await getDatabase().query(
    `UPDATE remote_agent_start_receipt_bindings SET preparation_status = 'complete'
      WHERE receipt_id IN (${receipts})`,
    [endedRunId]
  );
  await getDatabase().query(
    `UPDATE remote_agent_resource_start_requests SET status = 'admitted'
      WHERE receipt_id IN (${receipts})`,
    [endedRunId]
  );
  return startRun(itemKey, workflow);
}

test('an open ask gets one new comment with its options and the command that answers it', async () => {
  const fake = fakeForge();
  const tracker = await activeTracker(fake.forge);
  const run = await startRun('issue-7', 'plan');
  await endRun(run, 'completed', 'asked');
  await leaveAsk(run);
  await tracker.scan();
  await tracker.scan();
  const [ask, ...rest] = newComments(fake);
  // An open ask means the work is not over, so no result comment follows it.
  expect(rest).toEqual([]);
  expect(ask).toContain('**Keep the old flag?**');
  expect(ask).toContain('- `keep`: Keeps the flag. Cost: Two names for one thing.');
  expect(ask).toContain('Recommended: `drop`. The scripts are ours.');
  expect(ask).toMatch(/archon workflow answer --ref ask:\S+ --choose <option>/);
  expect(fake.calls.filter(call => call.marker.includes('archon-item-ask')).length).toBe(1);
});

test('a run paused at an attention wait gets one question comment with its options', async () => {
  const fake = fakeForge();
  const tracker = await activeTracker(fake.forge);
  const run = await startRun('issue-7', 'implement');
  await tracker.scan();
  await pauseAtWait(run);
  await tracker.scan();
  await tracker.scan();
  const [question, ...rest] = newComments(fake);
  expect(rest).toEqual([]);
  expect(question).toContain('> Which base branch?');
  expect(question).toContain('- `use-dev`: dev. Targets dev.');
  expect(question).toContain(
    `archon workflow answer ${run} --occurrence pause-1 --choose <option>`
  );
  // The status comment shows the paused run as in progress, and was not edited for the pause.
  expect(fake.status()?.edits).toBe(0);
});

test('a recorded ruling gets one new comment with its text; a withdrawn one gets none', async () => {
  const fake = fakeForge();
  const tracker = await activeTracker(fake.forge);
  await startRun('issue-7', 'plan');
  await tracker.scan();
  await recordItemRuling({
    projectKey: PROJECT,
    key: 'issue-7',
    text: 'Ship it behind the flag.',
    ...act,
  });
  const withdrawn = await recordItemRuling({
    projectKey: PROJECT,
    key: 'issue-7',
    text: 'Never mind.',
    ...act,
  });
  await withdrawItemRuling({ rulingId: withdrawn.id, ...act });
  await tracker.scan();
  await tracker.scan();
  const comments = newComments(fake);
  expect(comments.length).toBe(1);
  expect(comments[0]).toContain('> Ship it behind the flag.');
  expect(comments[0]).not.toContain('Private Person');
});

test('the result is posted once, when a run ends without starting a next stage', async () => {
  const fake = fakeForge();
  const tracker = await activeTracker(fake.forge);
  const plan = await startRun('issue-7', 'plan');
  await recordRunEndedStart(plan);
  await endRun(plan, 'completed', 'ready');
  await tracker.scan();
  expect(newComments(fake)).toEqual([]);

  const implement = await admitNextStage(plan, 'issue-7', 'implement');
  await recordPullRequest(implement, 12);
  await endRun(implement, 'completed', 'delivered');
  await tracker.scan();
  await tracker.scan();
  const comments = newComments(fake);
  expect(comments.length).toBe(1);
  expect(comments[0]).toContain(
    'finished its work on this item: the `implement` stage completed with outcome `delivered`.'
  );
  expect(comments[0]).toContain('Proposed change: https://github.com/acme/widgets/pull/12');
  expect(comments[0]).not.toContain('private');
});

test('no result is posted while a stage a run end started waits for a resource slot', async () => {
  const fake = fakeForge();
  const tracker = await activeTracker(fake.forge);
  const plan = await startRun('issue-7', 'plan');
  await recordRunEndedStart(plan, 'resource');
  await endRun(plan, 'completed', 'ready');
  await tracker.scan();
  expect(newComments(fake)).toEqual([]);

  const implement = await admitNextStage(plan, 'issue-7', 'implement');
  await endRun(implement, 'completed', 'delivered');
  await tracker.scan();
  const comments = newComments(fake);
  expect(comments.length).toBe(1);
  expect(comments[0]).toContain('the `implement` stage completed with outcome `delivered`.');
});

test('a run-ended chain that ends between two scans still gets its result', async () => {
  const fake = fakeForge();
  const tracker = await activeTracker(fake.forge);
  const plan = await startRun('issue-7', 'plan');
  await tracker.scan();
  await recordRunEndedStart(plan);
  await endRun(plan, 'completed', 'ready');
  const implement = await admitNextStage(plan, 'issue-7', 'implement');
  await endRun(implement, 'completed', 'delivered');
  await tracker.scan();
  const comments = newComments(fake);
  expect(comments.length).toBe(1);
  expect(comments[0]).toContain('the `implement` stage completed with outcome `delivered`.');
});

test('with overlapping runs, no result is posted while a stage the earlier one started has no run', async () => {
  const fake = fakeForge();
  const tracker = await activeTracker(fake.forge);
  const plan = await startRun('issue-7', 'plan');
  const docs = await startRun('issue-7', 'docs');
  await tracker.scan();
  await recordRunEndedStart(plan);
  await endRun(plan, 'completed', 'ready');
  await endRun(docs, 'completed', 'written');
  await tracker.scan();
  expect(newComments(fake)).toEqual([]);

  const implement = await admitNextStage(plan, 'issue-7', 'implement');
  await tracker.scan();
  await endRun(implement, 'completed', 'delivered');
  await tracker.scan();
  const comments = newComments(fake);
  expect(comments.length).toBe(1);
  expect(comments[0]).toContain('the `implement` stage completed with outcome `delivered`.');
});

test('a run that resumes after its result was posted replaces that result when it ends', async () => {
  const fake = fakeForge();
  const tracker = await activeTracker(fake.forge);
  const run = await startRun('issue-7', 'implement');
  await endRun(run, 'failed');
  await tracker.scan();
  expect(newComments(fake)[0]).toContain('the `implement` stage failed');
  await resumeRun(run);
  await tracker.scan();
  await endRun(run, 'completed', 'delivered');
  await tracker.scan();
  const comments = newComments(fake);
  expect(comments.length).toBe(1);
  expect(comments[0]).toContain('the `implement` stage completed with outcome `delivered`.');
});

for (const written of ['status', 'result'] as const)
  test(`a run that resumes and ends again while its ${written} comment is written shows its new end`, async () => {
    const fake = fakeForge();
    let run = '';
    let resumed = false;
    // The resume and the second end commit after the forge applied the write and before
    // its row is recorded, so no scan sees the run live again.
    const forge: ItemTrackerForge = {
      ...fake.forge,
      upsertComment: async request => {
        const response = await fake.forge.upsertComment(request);
        const marker = written === 'status' ? ITEM_STATUS_MARKER : 'archon-item-result';
        if (!resumed && request.marker.includes(marker)) {
          resumed = true;
          await resumeRun(run);
          await endRun(run, 'completed', 'delivered');
        }
        return response;
      },
    };
    const tracker = await activeTracker(forge);
    run = await startRun('issue-7', 'implement');
    await endRun(run, 'failed');
    await tracker.scan();
    expect(resumed).toBe(true);
    await tracker.scan();
    expect(fake.status()?.body).toContain('| implement | completed | delivered |');
    const comments = newComments(fake);
    expect(comments.length).toBe(1);
    expect(comments[0]).toContain('the `implement` stage completed with outcome `delivered`.');
  });

test('a run that ends after the scan read it as live still gets its result', async () => {
  const fake = fakeForge();
  let late: string | undefined;
  // Ends the run on issue 7 while the scan writes issue 6, after it read issue 7's runs.
  const forge: ItemTrackerForge = {
    ...fake.forge,
    upsertComment: async request => {
      if (late && request.subject.ref.number === 6) {
        await endRun(late, 'completed', 'delivered');
        late = undefined;
      }
      return fake.forge.upsertComment(request);
    },
  };
  const tracker = await activeTracker(forge);
  await startRun('issue-6', 'plan');
  late = await startRun('issue-7', 'implement');
  await tracker.scan();
  expect(fake.calls[0]?.subject.ref.number).toBe(6);
  expect(late).toBeUndefined();
  await tracker.scan();
  expect(fake.status()?.body).toContain('| implement | completed | delivered |');
  expect(newComments(fake)).toEqual([
    expect.stringContaining('the `implement` stage completed with outcome `delivered`.'),
  ]);
});

test('when two stages end within one scan, the result shows the one that ended last', async () => {
  const fake = fakeForge();
  const tracker = await activeTracker(fake.forge);
  const implement = await startRun('issue-7', 'implement');
  const docs = await startRun('issue-7', 'docs');
  await tracker.scan();
  await endRun(docs, 'completed', 'written', {}, new Date('2026-11-17T10:00:00.000Z'));
  await endRun(implement, 'completed', 'delivered', {}, new Date('2026-11-17T10:05:00.000Z'));
  await tracker.scan();
  expect(newComments(fake)).toEqual([
    expect.stringContaining('the `implement` stage completed with outcome `delivered`.'),
  ]);
});

test('a run that starts, ends and leaves an ask while the status is written holds the result back', async () => {
  const fake = fakeForge();
  let late = true;
  const forge: ItemTrackerForge = {
    ...fake.forge,
    upsertComment: async request => {
      const response = await fake.forge.upsertComment(request);
      if (late && request.marker === ITEM_STATUS_MARKER) {
        late = false;
        const review = await startRun('issue-7', 'review');
        await endRun(review, 'completed', 'asked');
        await leaveAsk(review);
      }
      return response;
    },
  };
  const tracker = await activeTracker(forge);
  const plan = await startRun('issue-7', 'plan');
  await endRun(plan, 'completed', 'ready');
  await tracker.scan();
  expect(late).toBe(false);
  expect(newComments(fake)).toEqual([]);
  await tracker.scan();
  expect(newComments(fake)).toEqual([expect.stringContaining('Keep the old flag?')]);
});

test('a result held back by an open ask is posted once the ask is withdrawn', async () => {
  const fake = fakeForge();
  const tracker = await activeTracker(fake.forge);
  const run = await startRun('issue-7', 'plan');
  await endRun(run, 'completed', 'asked');
  await leaveAsk(run);
  await tracker.scan();
  expect(newComments(fake).length).toBe(1);
  const item = await ensureItemInProject(
    getDatabase().query.bind(getDatabase()),
    PROJECT,
    'issue-7'
  );
  const [ask] = await listItemAsks(item);
  if (!ask || 'type' in ask) throw new Error('expected a readable ask');
  await withdrawItemAsk({ askId: ask.id, ...act });
  await tracker.scan();
  const comments = newComments(fake);
  expect(comments.length).toBe(2);
  expect(comments[1]).toContain('the `plan` stage completed with outcome `asked`.');
});

test('a run that cannot be read keeps the item from reading as finished', async () => {
  const fake = fakeForge();
  const tracker = await activeTracker(fake.forge);
  const plan = await startRun('issue-7', 'plan');
  const unreadable = await startRun('issue-7', 'implement');
  // A status this binary does not know, as a newer one could write.
  await getDatabase().query(
    "UPDATE remote_agent_workflow_runs SET status = 'drafting' WHERE id = $1",
    [unreadable]
  );
  await endRun(plan, 'completed', 'ready');
  await tracker.scan();
  await tracker.scan();
  expect(fake.status()?.body).toContain('could not read 1 of the stages on this item');
  expect(newComments(fake)).toEqual([]);
});

test('a run that resumes and ends again between two scans shows its new end', async () => {
  const fake = fakeForge();
  const tracker = await activeTracker(fake.forge);
  const run = await startRun('issue-7', 'implement');
  await endRun(run, 'failed');
  await tracker.scan();
  await resumeRun(run);
  await endRun(run, 'completed', 'delivered');
  await tracker.scan();
  expect(fake.status()?.body).toContain('| implement | completed | delivered |');
  const comments = newComments(fake);
  expect(comments.length).toBe(1);
  expect(comments[0]).toContain('the `implement` stage completed with outcome `delivered`.');
});

test('turning the tracker on posts nothing for questions, asks and rulings already there', async () => {
  const fake = fakeForge();
  const asked = await startRun('issue-7', 'plan');
  await endRun(asked, 'completed', 'asked');
  await leaveAsk(asked);
  await pauseAtWait(await startRun('issue-8', 'implement'));
  await recordItemRuling({ projectKey: PROJECT, key: 'issue-7', text: 'Earlier ruling.', ...act });
  const tracker = await activeTracker(fake.forge);
  await tracker.scan();
  await tracker.scan();
  expect(newComments(fake)).toEqual([]);
  // The paused run's item gets its status comment, since its run is live.
  expect(fake.calls.map(call => call.subject.ref.number)).toEqual([8]);
});

test('after a refused write and a restart, a run that ended meanwhile is shown', async () => {
  const fake = fakeForge();
  // A first activation with no runs has nothing to baseline.
  const tracker = await activeTracker(fake.forge);
  const run = await startRun('issue-9', 'plan');
  fake.fail({
    operationId: 'op',
    ok: false,
    error: { kind: 'authorization', message: 'no' },
    mutation: { op: 'workitem.comment.upsert', target: { repo, number: 9 }, outcome: 'refused' },
  });
  await tracker.scan();
  await endRun(run, 'completed', 'ready');
  await tracker.scan();
  await (await activeTracker(fake.forge)).scan();
  expect(fake.status(9)?.body).toContain('| plan | completed | ready |');
});

const DESTINATION = `tracker:${PROJECT}`;
/** Another process on this host; this one proves it gone, as it shares this pid. */
const goneProcess = { ...currentProcessOwner, instance: 'an-earlier-process' };

async function destinationRows(): Promise<number> {
  return (await getDatabase().query('SELECT 1 FROM remote_agent_item_tracker_destinations')).rows
    .length;
}

test('a pass that finds the project held asks the holder for one more, and nothing is posted twice', async () => {
  const fake = fakeForge();
  const parked = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let first = true;
  const parking: ItemTrackerForge = {
    ...fake.forge,
    upsertComment: async request => {
      if (first) {
        first = false;
        parked.resolve();
        await gate.promise;
      }
      return fake.forge.upsertComment(request);
    },
  };
  const holder = await activeTracker(parking);
  const plan = await startRun('issue-7', 'plan');
  await endRun(plan, 'completed', 'ready');
  const holderPass = holder.scan();
  await parked.promise;

  // Another process ends a run on the item while the holder's write is in flight.
  const review = await startRun('issue-7', 'review');
  await endRun(review, 'failed');
  const other = new ItemTracker(trackerConfig(), fake.forge, {
    ...currentProcessOwner,
    instance: 'cli-process',
  });
  await other.activate();
  const [held] = await other.scan({ request: true });
  expect(held?.outcome).toBe('held');
  if (held?.outcome !== 'held') throw new Error('expected a held pass');
  expect(held.heldBy).toEqual(currentProcessOwner);
  const callsWhileHeld = fake.calls.length;
  expect(callsWhileHeld).toBe(0);

  gate.resolve();
  const [report] = await holderPass;
  expect(report?.outcome).toBe('scanned');
  expect(fake.status()?.body).toContain('| plan | completed | ready |');
  expect(fake.status()?.body).toContain('| review | failed |');
  expect([...fake.comments.values()].map(comment => comment.posts)).toEqual([1, 1]);
  expect(newComments(fake)).toEqual([expect.stringContaining('the `review` stage failed')]);
  // The holder let go once it ran the pass it was asked for.
  expect((await other.scan({ request: true }))[0]?.outcome).toBe('scanned');
});

test('a pass held by a process this host proves gone is taken over', async () => {
  const fake = fakeForge();
  const tracker = await activeTracker(fake.forge);
  expect(await claimTrackerPass(DESTINATION, goneProcess, false)).toEqual({ claimed: true });
  const run = await startRun('issue-7', 'plan');
  await endRun(run, 'completed', 'ready');
  expect((await tracker.scan({ request: true }))[0]?.outcome).toBe('scanned');
  expect(fake.status()?.posts).toBe(1);
  expect(newComments(fake)).toEqual([expect.stringContaining('the `plan` stage completed')]);
});

test('a run that starts and ends while no tracker runs after first activation is posted', async () => {
  const fake = fakeForge();
  await activeTracker(fake.forge);
  expect(await destinationRows()).toBe(1);
  expect(
    (
      await getDatabase().query(
        "SELECT 1 FROM remote_agent_workflow_events WHERE event_type = 'attention_notice_sent'"
      )
    ).rows
  ).toEqual([]);
  const run = await startRun('issue-7', 'plan');
  await endRun(run, 'completed', 'ready');
  await (await activeTracker(fake.forge)).scan();
  expect(fake.status()?.body).toContain('| plan | completed | ready |');
  expect(newComments(fake)).toEqual([expect.stringContaining('the `plan` stage completed')]);
});

test('a destination a binary from before the destination row turned on is not baselined again', async () => {
  const fake = fakeForge();
  const tracker = await activeTracker(fake.forge);
  await startRun('issue-7', 'plan');
  await tracker.scan();
  await getDatabase().query('DELETE FROM remote_agent_item_tracker_destinations');
  const later = await startRun('issue-8', 'implement');
  await endRun(later, 'completed', 'delivered');
  await (await activeTracker(fake.forge)).scan();
  expect(await destinationRows()).toBe(1);
  expect(fake.status(8)?.body).toContain('| implement | completed | delivered |');
});

test('an operator release refuses a pass held by a live process here and frees a gone one', async () => {
  await activeTracker(fakeForge().forge);
  expect(await releaseTrackerPass(DESTINATION)).toBe('not_held');
  await claimTrackerPass(DESTINATION, currentProcessOwner, false);
  expect(await releaseTrackerPass(DESTINATION)).toBe('owner_running');
  await getDatabase().query(
    'UPDATE remote_agent_item_tracker_destinations SET pass_owner_instance = $1',
    [goneProcess.instance]
  );
  expect(await releaseTrackerPass(DESTINATION)).toBe('released');
  expect(await claimTrackerPass(DESTINATION, currentProcessOwner, false)).toEqual({
    claimed: true,
  });
});
