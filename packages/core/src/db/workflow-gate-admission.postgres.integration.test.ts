import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import type { Pool } from 'pg';
import { readGateQueue } from '@archon/workflows/schemas/workflow-run';
import type { PostgresAdapter } from './adapters/postgres';

const baseUrl = process.env.ARCHON_TEST_PG_URL;
const scratchName = `archon_gate_${crypto.randomUUID().replaceAll('-', '')}`;

describe.skipIf(!baseUrl)('gate admission — scratch PostgreSQL', () => {
  let admin: Pool;
  let db: PostgresAdapter;
  let scratchUrl: string;
  let created = false;
  let gates: typeof import('./workflow-gate-admission');
  let workflows: typeof import('./workflows');
  let conversationId: string;

  beforeAll(async () => {
    if (!baseUrl) throw new Error('ARCHON_TEST_PG_URL is required');
    const { Pool } = await import('pg');
    admin = new Pool({ connectionString: baseUrl });
    await admin.query(`CREATE DATABASE "${scratchName}"`);
    created = true;
    const url = new URL(baseUrl);
    url.pathname = `/${scratchName}`;
    scratchUrl = url.toString();
    const { PostgresAdapter, postgresDialect } = await import('./adapters/postgres');
    db = new PostgresAdapter(scratchUrl);
    mock.module('./connection', () => ({
      pool: { query: (...args: Parameters<PostgresAdapter['query']>) => db.query(...args) },
      getDatabase: () => db,
      getDialect: () => postgresDialect,
      getDatabaseType: () => 'postgresql',
    }));
    gates = await import('./workflow-gate-admission');
    workflows = await import('./workflows');
    conversationId = crypto.randomUUID();
    await db.query(
      "INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id) VALUES ($1::uuid, 'test', $1::text)",
      [conversationId]
    );
  });

  afterAll(async () => {
    await db?.close();
    if (created) await admin.query(`DROP DATABASE "${scratchName}" WITH (FORCE)`);
    await admin?.end();
  });

  async function seed(parentRunId?: string, nodeId?: string): Promise<string> {
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO remote_agent_workflow_runs (id, conversation_id, workflow_name, user_message, status, parent_run_id, metadata)
       VALUES ($1, $2, 'gates', '', 'running', $3, $4::jsonb)`,
      [
        id,
        conversationId,
        parentRunId ?? null,
        JSON.stringify(nodeId ? { parent_node_id: nodeId } : {}),
      ]
    );
    return id;
  }

  test('concurrent children serialize on the root and preserve exact decisions across reconnect', async () => {
    const parent = await seed();
    const first = await seed(parent, 'first');
    const second = await seed(parent, 'second');
    const admissions = await Promise.all(
      [first, second].map(runId =>
        gates.registerWorkflowGate(runId, {
          nodeId: 'review',
          message: `Review ${runId}`,
          type: 'approval',
        })
      )
    );
    expect(admissions.map(admission => admission.status)).toEqual(['registered', 'registered']);
    let queue = readGateQueue((await workflows.getWorkflowRun(parent))!.metadata)!;
    expect(queue.pending).toHaveLength(1);
    await gates.settleWorkflowGates(first);
    await gates.settleWorkflowGates(second);
    expect(await gates.claimWorkflowGatePresentation(parent)).toBeNull();
    await gates.settleWorkflowGates(parent);
    const selected = (await gates.claimWorkflowGatePresentation(parent))!;
    expect(await gates.claimWorkflowGatePresentation(parent)).toBeNull();
    await db.close();
    const { PostgresAdapter } = await import('./adapters/postgres');
    db = new PostgresAdapter(scratchUrl);
    expect(await gates.claimWorkflowGatePresentation(parent)).toBeNull();
    await gates.confirmWorkflowGatePresentation(parent, selected.id);
    const pending = queue.pending[0];
    expect(
      await workflows.resolveApprovalGate(
        pending.runId,
        {
          approval: { ...pending.context, gateId: pending.id, resolved: 'approved' },
        },
        []
      )
    ).toEqual({ resolved: false });
    expect(
      (
        await workflows.resolveApprovalGate(
          selected.runId,
          {
            approval: { ...selected.context, gateId: selected.id, resolved: 'approved' },
            approval_response: 'first only',
          },
          [{ event_type: 'approval_received', step_name: 'review', data: { decision: 'approve' } }]
        )
      ).resolved
    ).toBe(true);
    queue = readGateQueue((await workflows.getWorkflowRun(parent))!.metadata)!;
    expect(queue.active?.id).toBe(pending.id);
    expect(queue.resolved[0].response.approval_response).toBe('first only');
    const claims = await Promise.all([
      gates.claimWorkflowGatePresentation(parent),
      gates.claimWorkflowGatePresentation(parent),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const audit = await db.query<{ event_type: string }>(
      'SELECT event_type FROM remote_agent_workflow_events WHERE workflow_run_id IN ($1, $2)',
      [first, second]
    );
    expect(audit.rows.filter(row => row.event_type === 'approval_requested')).toHaveLength(2);
    expect(audit.rows.filter(row => row.event_type === 'approval_received')).toHaveLength(1);
  });
});
