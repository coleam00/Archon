import { createHash } from 'node:crypto';
import { getDatabase, getDatabaseType } from './connection';
import type { IDatabase } from './adapters/types';

export const GATE_EVIDENCE_POLICY = 'approval-evidence.v1';

export type TransactionQuery = Parameters<Parameters<IDatabase['withTransaction']>[0]>[0];
export interface GateCommandBinding {
  commandId: string;
  expectedOccurrence: string;
  expectedEvidenceDigest: string;
}
export interface GateCommand extends GateCommandBinding {
  runId: string;
  decision: string;
  text?: string;
}
export interface CommandReceipt {
  ok: boolean;
  commandId: string;
  runId: string;
  code?: string;
  message?: string;
  occurrenceId?: string;
  evidenceDigest?: string;
  decision?: string;
  resumable?: boolean;
  payloadDigest?: string;
}

/** Sort object keys so wire property order cannot change command identity. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      );
    }
    return item;
  });
}
export function evidenceDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

interface StoredCommand {
  payload_digest: string;
  receipt: string | null;
}

export async function readCommand(
  query: TransactionQuery,
  kind: string,
  commandId: string,
  digest: string,
  runId: string
): Promise<CommandReceipt | null> {
  await query(
    `INSERT INTO remote_agent_workflow_commands
    (kind, command_id, payload_digest, run_id) VALUES ($1, $2, $3, $4)
    ON CONFLICT (kind, command_id) DO NOTHING`,
    [kind, commandId, digest, runId]
  );
  const row = (
    await query<StoredCommand>(
      `SELECT payload_digest, receipt
    FROM remote_agent_workflow_commands WHERE kind = $1 AND command_id = $2${getDatabaseType() === 'postgresql' ? ' FOR UPDATE' : ''}`,
      [kind, commandId]
    )
  ).rows[0];
  if (!row) throw new Error('Command reservation was not persisted');
  if (row.payload_digest !== digest) {
    const rejection: CommandReceipt = {
      ok: false,
      commandId,
      runId,
      code: 'command_payload_conflict',
      message: 'Command identity was already used with a different payload.',
    };
    await query(
      `INSERT INTO remote_agent_workflow_command_rejections
      (kind, command_id, payload_digest, receipt) VALUES ($1, $2, $3, $4)
      ON CONFLICT (kind, command_id, payload_digest) DO NOTHING`,
      [kind, commandId, digest, JSON.stringify(rejection)]
    );
    const stored = (
      await query<{ receipt: string }>(
        `SELECT receipt FROM remote_agent_workflow_command_rejections
      WHERE kind = $1 AND command_id = $2 AND payload_digest = $3`,
        [kind, commandId, digest]
      )
    ).rows[0];
    if (!stored) throw new Error('Command rejection was not persisted');
    return JSON.parse(stored.receipt) as CommandReceipt;
  }
  return row.receipt === null ? null : (JSON.parse(row.receipt) as CommandReceipt);
}

export async function storeCommandReceipt(
  query: TransactionQuery,
  kind: string,
  commandId: string,
  receipt: CommandReceipt
): Promise<void> {
  await query(
    `UPDATE remote_agent_workflow_commands SET receipt = $3
    WHERE kind = $1 AND command_id = $2 AND receipt IS NULL`,
    [kind, commandId, JSON.stringify(receipt)]
  );
}

export async function gateCommandReceipt(
  command: GateCommand,
  rejection?: { code: string; message: string }
): Promise<CommandReceipt | null> {
  return getDatabase().withTransaction(async query => {
    const existing = await readCommand(
      query,
      'respond',
      command.commandId,
      evidenceDigest(command),
      command.runId
    );
    if (existing || !rejection) return existing;
    const receipt: CommandReceipt = {
      ok: false,
      commandId: command.commandId,
      runId: command.runId,
      ...rejection,
    };
    await storeCommandReceipt(query, 'respond', command.commandId, receipt);
    return receipt;
  });
}

/** The effect, audit events and receipt share the engine's transaction. */
export async function resolveWithCommand(
  command: GateCommand | undefined,
  cancelled: boolean,
  effect: (query: TransactionQuery) => Promise<{ resolved: boolean }>
): Promise<{ resolved: boolean }> {
  return getDatabase().withTransaction(async query => {
    if (!command) return effect(query);
    const existing = await readCommand(
      query,
      'respond',
      command.commandId,
      evidenceDigest(command),
      command.runId
    );
    if (existing) return { resolved: existing.ok };
    const row = (
      await query<{ status: string; metadata: unknown }>(
        `SELECT status, metadata FROM remote_agent_workflow_runs WHERE id = $1${getDatabaseType() === 'postgresql' ? ' FOR UPDATE' : ''}`,
        [command.runId]
      )
    ).rows[0];
    const metadata =
      typeof row?.metadata === 'string'
        ? (JSON.parse(row.metadata) as Record<string, unknown>)
        : (row?.metadata as Record<string, unknown> | undefined);
    const approval = metadata?.approval as Record<string, unknown> | undefined;
    const seal = (
      await query<{ evidence_digest: string; evidence: string }>(
        `SELECT evidence_digest, evidence FROM remote_agent_gate_occurrences
      WHERE run_id = $1 AND occurrence_id = $2`,
        [command.runId, command.expectedOccurrence]
      )
    ).rows[0];
    const original = seal
      ? (JSON.parse(seal.evidence) as {
          approval: Record<string, unknown>;
          metadata: Record<string, unknown>;
          artifactPolicy?: unknown;
        })
      : undefined;
    const currentApproval = { ...approval };
    delete currentApproval.occurrenceId;
    delete currentApproval.evidenceDigest;
    // The DAG writes accounting totals after a pause. They do not change the
    // reviewed source; every other metadata field remains part of the guard.
    const bookkeeping = new Set([
      'approval',
      'total_cost_usd',
      'total_tokens_in',
      'total_tokens_out',
      'total_cache_read_tokens',
      'total_cache_write_tokens',
      'total_cache_partial',
    ]);
    const currentMetadata = Object.fromEntries(
      Object.entries(metadata ?? {}).filter(([key]) => !bookkeeping.has(key))
    );
    const originalMetadata = Object.fromEntries(
      Object.entries(original?.metadata ?? {}).filter(([key]) => !bookkeeping.has(key))
    );
    const matches =
      original?.artifactPolicy === GATE_EVIDENCE_POLICY &&
      evidenceDigest(original) === seal?.evidence_digest &&
      canonicalJson(original.approval) === canonicalJson(currentApproval) &&
      canonicalJson(originalMetadata) === canonicalJson(currentMetadata) &&
      row?.status === 'paused' &&
      approval?.resolved == null &&
      approval?.occurrenceId === command.expectedOccurrence &&
      approval.evidenceDigest === command.expectedEvidenceDigest &&
      seal?.evidence_digest === command.expectedEvidenceDigest;
    const result = matches ? await effect(query) : { resolved: false };
    const receipt: CommandReceipt = result.resolved
      ? {
          ok: true,
          commandId: command.commandId,
          runId: command.runId,
          occurrenceId: command.expectedOccurrence,
          evidenceDigest: command.expectedEvidenceDigest,
          decision: command.decision,
          resumable: !cancelled,
        }
      : {
          ok: false,
          commandId: command.commandId,
          runId: command.runId,
          code: 'stale_gate',
          message: 'Run, gate occurrence or sealed evidence no longer matches.',
        };
    await storeCommandReceipt(query, 'respond', command.commandId, receipt);
    return result;
  });
}

/** Reserve the exact execution identity before any workflow can start. No lease expires. */
export async function reserveWorkflowLaunch(
  commandId: string,
  digest: string,
  proposedRunId: string,
  expectedDigest?: string
): Promise<{ launch: boolean; receipt: CommandReceipt }> {
  return getDatabase().withTransaction(async query => {
    // The expectation is part of the request too: fixing a rejected request needs a new key.
    const requestDigest = evidenceDigest({ digest, expectedDigest: expectedDigest ?? null });
    const existing = await readCommand(query, 'launch', commandId, requestDigest, proposedRunId);
    if (existing) return { launch: false, receipt: existing };
    const receipt: CommandReceipt =
      expectedDigest !== undefined && expectedDigest !== digest
        ? {
            ok: false,
            commandId,
            runId: proposedRunId,
            code: 'launch_payload_mismatch',
            message: 'Actual engine launch intent does not match the expected digest.',
            payloadDigest: digest,
          }
        : { ok: true, commandId, runId: proposedRunId, payloadDigest: digest };
    await storeCommandReceipt(query, 'launch', commandId, receipt);
    return { launch: receipt.ok, receipt };
  });
}

/** A reservation without a run row is uncertain, never permission to launch again. */
export async function getWorkflowLaunch(
  commandId: string
): Promise<{ receipt: CommandReceipt; status: string } | null> {
  return getDatabase().withTransaction(async query => {
    const command = (
      await query<{ receipt: string | null; run_id: string }>(
        `SELECT receipt, run_id
      FROM remote_agent_workflow_commands WHERE kind = 'launch' AND command_id = $1`,
        [commandId]
      )
    ).rows[0];
    if (!command?.receipt) return null;
    const run = (
      await query<{ status: string }>(
        'SELECT status FROM remote_agent_workflow_runs WHERE id = $1',
        [command.run_id]
      )
    ).rows[0];
    const receipt = JSON.parse(command.receipt) as CommandReceipt;
    return { receipt, status: run?.status ?? (receipt.ok ? 'uncertain' : 'rejected') };
  });
}

export async function getGateEvidence(
  runId: string,
  occurrenceId: string
): Promise<{
  runId: string;
  occurrenceId: string;
  evidenceDigest: string;
  evidence: unknown;
} | null> {
  const row = (
    await getDatabase().query<{ evidence: string; evidence_digest: string }>(
      'SELECT evidence, evidence_digest FROM remote_agent_gate_occurrences WHERE run_id = $1 AND occurrence_id = $2',
      [runId, occurrenceId]
    )
  ).rows[0];
  if (!row) return null;
  const evidence = JSON.parse(row.evidence) as { artifactPolicy?: unknown };
  if (evidence.artifactPolicy !== GATE_EVIDENCE_POLICY) {
    throw new Error(
      'Legacy gate evidence cannot be exposed; reopen the gate with the current engine'
    );
  }
  if (evidenceDigest(evidence) !== row.evidence_digest) {
    throw new Error('Gate evidence integrity check failed');
  }
  return { runId, occurrenceId, evidenceDigest: row.evidence_digest, evidence };
}
