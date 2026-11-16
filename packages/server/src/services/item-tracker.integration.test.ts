import { Pool } from 'pg';
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
import { openItemAsksForCompletedRun } from '@archon/core/db/item-asks';
import { recordItemRuling, withdrawItemRuling } from '@archon/core/db/item-rulings';
import { ensureItemInProject } from '@archon/core/db/items';
import { createWorkflowRun } from '@archon/core/db/workflows';
import { insertWorkflowEvent, listAttentionNotices } from '@archon/core/db/workflow-events';
import { removeTempTree } from '@archon/paths/test-utils';
import { ItemTracker, type ItemTrackerForge } from './item-tracker';
import { ITEM_STATUS_MARKER } from './item-tracker-render';

let root: string;
let savedHome: string | undefined;
let savedDatabase: string | undefined;
const postgresUrl = process.env.ARCHON_TEST_PG_URL;
let postgresAdmin: Pool | undefined;
let scratchDatabase: string | undefined;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'archon-item-tracker-test-'));
  savedHome = process.env.ARCHON_HOME;
  savedDatabase = process.env.DATABASE_URL;
  process.env.ARCHON_HOME = root;
  process.env.DATABASE_URL = '';
  if (postgresUrl) {
    postgresAdmin = new Pool({ connectionString: postgresUrl });
    scratchDatabase = `archon_tracker_${crypto.randomUUID().replaceAll('-', '')}`;
    await postgresAdmin.query(`CREATE DATABASE "${scratchDatabase}"`);
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
      await postgresAdmin.query(`DROP DATABASE "${scratchDatabase}" WITH (FORCE)`);
    } finally {
      await postgresAdmin.end();
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
function fakeForge(check: ForgeAccessCheck = { ok: true, plugin: { name: 'fake', version: '1' } }) {
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
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await getDatabase().query(
    'UPDATE remote_agent_workflow_runs SET status = $1, completed_outcome = $2, metadata = $3 WHERE id = $4',
    [status, outcome, JSON.stringify(metadata), runId]
  );
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
  await endRun(run, 'running');
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
  // One terminal row per run, and the anchor that records the tracker as on.
  expect(settled).toBe(5);
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
  await tracker.scan();
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
  await tracker.scan();
  expect(await shownRows(run)).toEqual([]);
  await tracker.scan();
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
  await tracker.scan();
  expect(fake.calls.filter(call => call.subject.ref.number === 404).length).toBe(1);
  expect(await shownRows(missing)).toEqual([]);
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

async function recordRunEndedStart(endedRunId: string): Promise<void> {
  await getDatabase().query(
    `INSERT INTO remote_agent_start_receipts
     (id, source_instance_id, delivery_id, content_digest, received_at, source_actor, outcome)
     VALUES ($1, 'next-stage', $2, 'digest', $3, $4, 'matched')`,
    [
      crypto.randomUUID(),
      endedRunId,
      new Date().toISOString(),
      JSON.stringify({ source: 'archon-run-ended', id: endedRunId }),
    ]
  );
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

  const implement = await startRun('issue-7', 'implement');
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

test('a run-ended chain that ends between two scans still gets its result', async () => {
  const fake = fakeForge();
  const tracker = await activeTracker(fake.forge);
  const plan = await startRun('issue-7', 'plan');
  await tracker.scan();
  await recordRunEndedStart(plan);
  await endRun(plan, 'completed', 'ready');
  const implement = await startRun('issue-7', 'implement');
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
  await endRun(run, 'running');
  await tracker.scan();
  await endRun(run, 'completed', 'delivered');
  await tracker.scan();
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
