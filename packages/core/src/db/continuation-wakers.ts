/**
 * The recorded continuation wakers (`IWorkflowStore.listContinuationWakers`), one row per
 * waker in `remote_agent_continuation_wakers`; see migrations/000_combined.sql.
 */
import { isOwnerProvablyGone } from '@archon/paths/process-owner';
import type { ContinuationWaker } from '@archon/workflows/schemas/continuation-waker';
import { pool } from './connection';

interface WakerRow {
  host: string;
  kind: string;
  pid: number | string | null;
  instance: string | null;
}

function wakerId(waker: ContinuationWaker): string {
  return waker.kind === 'process'
    ? `process:${waker.host}:${waker.pid}:${waker.instance}`
    : `${waker.kind}:${waker.host}`;
}

function wakerOf(row: WakerRow): ContinuationWaker | null {
  if (row.kind === 'schedule' || row.kind === 'pass') return { kind: row.kind, host: row.host };
  if (row.kind !== 'process' || row.pid === null || row.instance === null) return null;
  return { kind: 'process', host: row.host, pid: Number(row.pid), instance: row.instance };
}

export async function recordContinuationWaker(waker: ContinuationWaker): Promise<void> {
  const owner = waker.kind === 'process' ? waker : null;
  await pool.query(
    `INSERT INTO remote_agent_continuation_wakers (id, host, kind, pid, instance, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET recorded_at = EXCLUDED.recorded_at`,
    [
      wakerId(waker),
      waker.host,
      waker.kind,
      owner?.pid ?? null,
      owner?.instance ?? null,
      new Date().toISOString(),
    ]
  );
  // Each start of a process adds a row, so forget the ones this host proves gone.
  for (const recorded of await listContinuationWakers())
    if (recorded.kind === 'process' && isOwnerProvablyGone(recorded))
      await pool.query(
        `DELETE FROM remote_agent_continuation_wakers
         WHERE kind = 'process' AND host = $1 AND pid = $2 AND instance = $3`,
        [recorded.host, recorded.pid, recorded.instance]
      );
}

export async function removeContinuationSchedule(host: string): Promise<void> {
  await pool.query('DELETE FROM remote_agent_continuation_wakers WHERE id = $1', [
    wakerId({ kind: 'schedule', host }),
  ]);
}

/**
 * The recorded wakers. A row this binary cannot read, such as a kind a newer one added,
 * reads as a `pass` on its host: it may still pass, so nothing is listed for want of it.
 */
export async function listContinuationWakers(): Promise<ContinuationWaker[]> {
  const rows = await pool.query<WakerRow>(
    'SELECT host, kind, pid, instance FROM remote_agent_continuation_wakers ORDER BY id'
  );
  return rows.rows.map(row => wakerOf(row) ?? { kind: 'pass', host: row.host });
}
