import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { afterAll, describe, expect, mock, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRunArtifactsDirForRoot } from '@archon/paths';
import { trackTempRoots } from '@archon/paths/test-utils';
import { SqliteAdapter } from './adapters/sqlite';
import { PostgresAdapter } from './adapters/postgres';
import type { IDatabase } from './adapters/types';
import { Pool } from 'pg';

const postgresUrl = process.env.ARCHON_TEST_PG_URL;
const scratchName = `archon_commands_${randomUUID().replaceAll('-', '')}`;
let admin: Pool | undefined;
let db: IDatabase;
if (postgresUrl) {
  admin = new Pool({ connectionString: postgresUrl });
  await admin.query(`CREATE DATABASE "${scratchName}"`);
  const url = new URL(postgresUrl);
  url.pathname = `/${scratchName}`;
  db = new PostgresAdapter(url.toString());
} else {
  db = new SqliteAdapter(':memory:');
}
afterAll(async () => {
  await db.close();
  if (admin) {
    await admin.query(`DROP DATABASE "${scratchName}" WITH (FORCE)`);
    await admin.end();
  }
});
const conversationId = randomUUID();
const trackTempRoot = trackTempRoots();
mock.module('./connection', () => ({
  pool: db,
  getDatabase: () => db,
  getDialect: () => db.sql,
  getDatabaseType: () => (postgresUrl ? 'postgresql' : 'sqlite'),
}));
const workflows = await import('./workflows');
const operations = await import('../operations/workflow-operations');
const commands = await import('./workflow-commands');
await db.query(
  `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
  VALUES ($1, 'cli', $2)`,
  [conversationId, conversationId]
);

type SealedGate = { occurrenceId: string; evidenceDigest: string };
async function getRun(id: string): Promise<WorkflowRun> {
  const run = await workflows.getWorkflowRun(id);
  if (!run) throw new Error(`Missing test run ${id}`);
  return run;
}
async function paused(): Promise<{ run: WorkflowRun; gate: SealedGate }> {
  const run = await workflows.createWorkflowRun({
    conversation_id: conversationId,
    workflow_name: 'command-gate',
    user_message: 'test',
  });
  await workflows.updateWorkflowRun(run.id, { status: 'running' });
  await workflows.pauseWorkflowRun(run.id, {
    nodeId: 'review',
    message: 'Review original evidence',
    type: 'approval',
    decisionsAuthored: true,
    decisions: [{ id: 'approve' }, { id: 'reject' }],
  });
  const gate = (await getRun(run.id)).metadata.approval as SealedGate;
  return { run, gate };
}

describe(`engine-bound command receipts (${postgresUrl ? 'PostgreSQL' : 'SQLite'})`, () => {
  test('the database cannot validate one run and resolve another', async () => {
    const first = await paused();
    const second = await paused();
    await expect(
      workflows.resolveApprovalGate(
        first.run.id,
        {
          approval: { ...first.gate, resolved: 'approved' },
        },
        [],
        {
          commandId: randomUUID(),
          runId: second.run.id,
          decision: 'approve',
          expectedOccurrence: second.gate.occurrenceId,
          expectedEvidenceDigest: second.gate.evidenceDigest,
        }
      )
    ).rejects.toThrow('Command run id does not match mutation target');
    expect((await getRun(first.run.id)).metadata.approval).not.toHaveProperty('resolved');
  });

  test('post-pause provider usage accounting does not replace reviewed source evidence', async () => {
    const { run, gate } = await paused();
    await workflows.updateWorkflowRun(run.id, {
      metadata: { total_cost_usd: 0.02, total_tokens_in: 10, total_tokens_out: 5 },
    });
    expect(
      await operations.respondToWorkflowConditionally(run.id, 'approve', undefined, {
        commandId: randomUUID(),
        expectedOccurrence: gate.occurrenceId,
        expectedEvidenceDigest: gate.evidenceDigest,
      })
    ).toMatchObject({ ok: true });
  });

  test('simultaneous decisions commit exactly one receipt and approval audit', async () => {
    const { run, gate } = await paused();
    const decisions = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        operations.respondToWorkflowConditionally(
          run.id,
          index % 2 === 0 ? 'approve' : 'reject',
          undefined,
          {
            commandId: randomUUID(),
            expectedOccurrence: gate.occurrenceId,
            expectedEvidenceDigest: gate.evidenceDigest,
          }
        )
      )
    );
    expect(decisions.filter(result => result.ok)).toHaveLength(1);
    expect(
      (
        await db.query(
          `SELECT id FROM remote_agent_workflow_events WHERE workflow_run_id = $1 AND event_type = 'approval_received'`,
          [run.id]
        )
      ).rowCount
    ).toBe(1);
    expect(
      (
        await db.query(
          `SELECT command_id FROM remote_agent_workflow_commands WHERE run_id = $1 AND receipt IS NOT NULL`,
          [run.id]
        )
      ).rowCount
    ).toBe(8);
  });

  test('audit failure rolls back decision and receipt, permitting the same command to retry', async () => {
    const { run, gate } = await paused();
    const binding = {
      commandId: randomUUID(),
      expectedOccurrence: gate.occurrenceId,
      expectedEvidenceDigest: gate.evidenceDigest,
    };
    await db.query('ALTER TABLE remote_agent_workflow_events RENAME TO stashed_events');
    try {
      await expect(
        operations.respondToWorkflowConditionally(run.id, 'approve', undefined, binding)
      ).rejects.toThrow('Failed to resolve');
      expect((await getRun(run.id)).metadata.approval).not.toHaveProperty('resolved');
      expect(
        (
          await db.query<{ receipt: string | null }>(
            `SELECT receipt FROM remote_agent_workflow_commands WHERE command_id = $1`,
            [binding.commandId]
          )
        ).rows[0]?.receipt
      ).toBeNull();
    } finally {
      await db.query('ALTER TABLE stashed_events RENAME TO remote_agent_workflow_events');
    }
    expect(
      await operations.respondToWorkflowConditionally(run.id, 'approve', undefined, binding)
    ).toMatchObject({ ok: true });
  });

  test('sealed original bytes survive artifact replacement and do not become a client digest', async () => {
    const { run } = await paused();
    const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-gate-evidence-')));
    const artifacts = getRunArtifactsDirForRoot(root, run.id);
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, 'review.txt'), 'original');
    await db.query(
      `UPDATE remote_agent_workflow_runs SET output_root = $2, status = 'running' WHERE id = $1`,
      [run.id, root]
    );
    await workflows.pauseWorkflowRun(run.id, {
      nodeId: 'review',
      message: 'Original source',
      occurrenceId: 'forged',
      evidenceDigest: 'client',
    });
    const gate = (await getRun(run.id)).metadata.approval as SealedGate;
    await writeFile(join(artifacts, 'review.txt'), 'replacement');
    const seal = (await commands.getGateEvidence(run.id, gate.occurrenceId)) as {
      evidence: { artifacts: SealedGate };
      evidenceDigest: string;
    };
    expect(gate.occurrenceId).not.toBe('forged');
    expect(seal.evidenceDigest).toBe(gate.evidenceDigest);
    expect(Buffer.from(seal.evidence.artifacts['review.txt'] ?? '', 'base64').toString()).toBe(
      'original'
    );
  });

  test('changing gate context or runtime source metadata rejects the bound decision', async () => {
    for (const change of [
      { approval: { message: 'Changed evidence' } },
      { workflow_source: { digest: 'changed' } },
    ]) {
      const { run, gate } = await paused();
      const metadata =
        'approval' in change
          ? {
              approval: {
                ...((await getRun(run.id)).metadata.approval as Record<string, unknown>),
                ...change.approval,
              },
            }
          : change;
      await workflows.updateWorkflowRun(run.id, { metadata });
      expect(
        await operations.respondToWorkflowConditionally(run.id, 'approve', undefined, {
          commandId: randomUUID(),
          expectedOccurrence: gate.occurrenceId,
          expectedEvidenceDigest: gate.evidenceDigest,
        })
      ).toMatchObject({ ok: false, code: 'stale_gate' });
    }
  });

  test('conditional legacy rejection stages on_reject and keeps the same run resumable', async () => {
    const { run } = await paused();
    await workflows.updateWorkflowRun(run.id, { status: 'running' });
    await workflows.pauseWorkflowRun(run.id, {
      nodeId: 'review',
      message: 'Review',
      onRejectPrompt: 'Fix the reported problem',
      onRejectMaxAttempts: 3,
    });
    const gate = (await getRun(run.id)).metadata.approval as SealedGate;
    expect(
      await operations.respondToWorkflowConditionally(run.id, 'reject', 'Fix the test', {
        commandId: randomUUID(),
        expectedOccurrence: gate.occurrenceId,
        expectedEvidenceDigest: gate.evidenceDigest,
      })
    ).toMatchObject({ ok: true, runId: run.id, resumable: true });
    expect((await getRun(run.id)).metadata).toMatchObject({
      rejection_count: 1,
      rejection_reason: 'Fix the test',
    });
    expect((await workflows.resumeWorkflowRun(run.id)).id).toBe(run.id);
  });

  test('conditional terminal rejection commits cancellation and replayable receipt together', async () => {
    const { run } = await paused();
    await workflows.updateWorkflowRun(run.id, { status: 'running' });
    await workflows.pauseWorkflowRun(run.id, { nodeId: 'review', message: 'Review' });
    const gate = (await getRun(run.id)).metadata.approval as SealedGate;
    const binding = {
      commandId: randomUUID(),
      expectedOccurrence: gate.occurrenceId,
      expectedEvidenceDigest: gate.evidenceDigest,
    };
    const receipt = await operations.respondToWorkflowConditionally(
      run.id,
      'reject',
      undefined,
      binding
    );
    expect(receipt).toMatchObject({ ok: true, resumable: false });
    expect((await getRun(run.id)).status).toBe('cancelled');
    expect(
      await operations.respondToWorkflowConditionally(run.id, 'reject', undefined, binding)
    ).toEqual(receipt);
    expect(
      (
        await db.query(
          `SELECT id FROM remote_agent_workflow_events WHERE workflow_run_id = $1 AND event_type = 'workflow_cancelled'`,
          [run.id]
        )
      ).rowCount
    ).toBe(1);
  });

  test('launch reservation races yield one owner and recover the same id after lost ACK', async () => {
    const key = randomUUID();
    const digest = 'a'.repeat(64);
    const attempts = await Promise.all(
      Array.from({ length: 6 }, () =>
        commands.reserveWorkflowLaunch(key, digest, randomUUID(), digest)
      )
    );
    expect(attempts.filter(attempt => attempt.launch)).toHaveLength(1);
    expect(new Set(attempts.map(attempt => attempt.receipt.runId)).size).toBe(1);
    const recovered = await commands.getWorkflowLaunch(key);
    expect(recovered).toMatchObject({ receipt: attempts[0]?.receipt, status: 'uncertain' });
    const changed = await commands.reserveWorkflowLaunch(key, 'b'.repeat(64), randomUUID());
    expect(changed).toMatchObject({
      launch: false,
      receipt: { ok: false, code: 'command_payload_conflict' },
    });
  });

  test('caller digest cannot disguise a different actual launch payload', async () => {
    const key = randomUUID();
    expect(
      await commands.reserveWorkflowLaunch(key, 'b'.repeat(64), randomUUID(), 'a'.repeat(64))
    ).toMatchObject({ launch: false, receipt: { ok: false, code: 'launch_payload_mismatch' } });
  });

  test('every pause gets a fresh occurrence even for identical context', async () => {
    const { run, gate } = await paused();
    expect(gate.occurrenceId).toBeString();
    expect(gate.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
    await workflows.updateWorkflowRun(run.id, { status: 'running' });
    await workflows.pauseWorkflowRun(run.id, {
      nodeId: 'review',
      message: 'Review original evidence',
      type: 'approval',
      decisionsAuthored: true,
      decisions: [{ id: 'approve' }, { id: 'reject' }],
    });
    const next = (await getRun(run.id)).metadata.approval as SealedGate;
    expect(next.occurrenceId).not.toBe(gate.occurrenceId);
  });

  test('same command returns its receipt after the gate advances; changed payload is durable reject', async () => {
    const { run, gate } = await paused();
    const command = {
      commandId: randomUUID(),
      expectedOccurrence: gate.occurrenceId,
      expectedEvidenceDigest: gate.evidenceDigest,
    };
    const first = await operations.respondToWorkflowConditionally(
      run.id,
      'approve',
      undefined,
      command
    );
    expect(first.ok).toBe(true);
    await workflows.updateWorkflowRun(run.id, { status: 'running' });
    await workflows.pauseWorkflowRun(run.id, {
      nodeId: 'review',
      message: 'Review original evidence',
    });
    expect(
      await operations.respondToWorkflowConditionally(run.id, 'approve', undefined, command)
    ).toEqual(first);
    const changed = await operations.respondToWorkflowConditionally(
      run.id,
      'reject',
      undefined,
      command
    );
    expect(changed).toMatchObject({ ok: false, code: 'command_payload_conflict' });
    expect(
      await operations.respondToWorkflowConditionally(run.id, 'reject', undefined, command)
    ).toEqual(changed);
    expect((await getRun(run.id)).metadata.approval).not.toHaveProperty('resolved');
  });

  test('stale identical gate occurrence is rejected without an approval event', async () => {
    const { run, gate } = await paused();
    await workflows.updateWorkflowRun(run.id, { status: 'running' });
    await workflows.pauseWorkflowRun(run.id, {
      nodeId: 'review',
      message: 'Review original evidence',
      type: 'approval',
      decisionsAuthored: true,
      decisions: [{ id: 'approve' }, { id: 'reject' }],
    });
    const result = await operations.respondToWorkflowConditionally(run.id, 'approve', undefined, {
      commandId: randomUUID(),
      expectedOccurrence: gate.occurrenceId,
      expectedEvidenceDigest: gate.evidenceDigest,
    });
    expect(result).toMatchObject({ ok: false, code: 'stale_gate' });
    expect(
      (
        await db.query(
          `SELECT * FROM remote_agent_workflow_events WHERE workflow_run_id = $1 AND event_type = 'approval_received'`,
          [run.id]
        )
      ).rowCount
    ).toBe(0);
  });
});
