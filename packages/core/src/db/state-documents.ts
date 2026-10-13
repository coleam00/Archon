import {
  applyStatePatch,
  statePutSchema,
  parseStatePatchInput,
  stateDeleteSchema,
  stateDocumentNameSchema,
  stateRevisionSchema,
  validateStateValue,
  StateRevisionConflictError,
  type IStateDocumentStore,
  type StateRevision,
} from '@archon/workflows/state-document-store';
import { z } from 'zod';
import type { IDatabase } from './adapters/types';
import { toHydratedTimestamp } from './timestamps';

type Query = IDatabase['query'];
interface RevisionRow {
  name: string;
  revision: number;
  value: string | null;
  operation: string;
  writer_kind: string;
  writer_run_id: string | null;
  writer_node_path: string | null;
  writer_identity: string | null;
  created_at: string | Date;
}
function hydrate(row: RevisionRow): StateRevision {
  return stateRevisionSchema.parse({
    name: row.name,
    revision: row.revision,
    value: row.value === null ? null : (JSON.parse(row.value) as unknown),
    operation: JSON.parse(row.operation) as unknown,
    writer:
      row.writer_kind === 'run'
        ? { kind: row.writer_kind, runId: row.writer_run_id, nodePath: row.writer_node_path }
        : { kind: row.writer_kind, identity: row.writer_identity },
    createdAt: toHydratedTimestamp(row.created_at).toISOString(),
  });
}
function scope(project: string, name: string): void {
  z.string().min(1).parse(project);
  stateDocumentNameSchema.parse(name);
}
async function latest(query: Query, project: string, name: string): Promise<StateRevision | null> {
  const result = await query<RevisionRow>(
    'SELECT * FROM remote_agent_state_revisions WHERE project_key = $1 AND name = $2 ORDER BY revision DESC LIMIT 1',
    [project, name]
  );
  return result.rows[0] ? hydrate(result.rows[0]) : null;
}
async function insert(query: Query, project: string, revision: StateRevision): Promise<void> {
  const writer = revision.writer;
  await query(
    `INSERT INTO remote_agent_state_revisions
    (project_key, name, revision, value, operation, writer_kind, writer_run_id, writer_node_path, writer_identity, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      project,
      revision.name,
      revision.revision,
      revision.value === null ? null : JSON.stringify(revision.value),
      JSON.stringify(revision.operation),
      writer.kind,
      writer.kind === 'run' ? writer.runId : null,
      writer.kind === 'run' ? writer.nodePath : null,
      writer.kind === 'operator' ? writer.identity : null,
      revision.createdAt,
    ]
  );
}

export function createSqlStateDocumentStore(
  database: () => Pick<IDatabase, 'query' | 'withTransaction' | 'dialect'>
): IStateDocumentStore {
  const query: Query = <T>(sql: string, params?: unknown[]) => database().query<T>(sql, params);
  const write = async (
    input: Parameters<IStateDocumentStore['deleteStateDocument']>[0],
    operation: StateRevision['operation'],
    compute: (prior: StateRevision | null) => StateRevision['value']
  ): Promise<StateRevision> => {
    const db = database();
    // Writers to one document serialize, so a write never loses a race for its revision
    // and only an explicit ifRevision mismatch fails. SQLite has one writer: a commit that
    // read a stale snapshot fails with SQLITE_BUSY_SNAPSHOT and the adapter reruns this
    // block. PostgreSQL READ COMMITTED needs a lock that also covers the first revision,
    // before any row exists to lock.
    return db.withTransaction(async txQuery => {
      if (db.dialect === 'postgres')
        await txQuery('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          JSON.stringify(['state-document', input.project, input.name]),
        ]);
      const prior = await latest(txQuery, input.project, input.name);
      const actual = prior?.revision ?? 0;
      if (input.ifRevision !== undefined && input.ifRevision !== actual)
        throw new StateRevisionConflictError(input.name, input.ifRevision, actual);
      const next: StateRevision = {
        name: input.name,
        revision: actual + 1,
        value: compute(prior),
        operation,
        writer: input.writer,
        createdAt: new Date().toISOString(),
      };
      await insert(txQuery, input.project, next);
      return next;
    });
  };
  return {
    getStateDocument: async (
      project,
      name
    ): ReturnType<IStateDocumentStore['getStateDocument']> => {
      scope(project, name);
      const row = await latest(query, project, name);
      return row?.value === null ? null : row;
    },
    putStateDocument: async (supplied): ReturnType<IStateDocumentStore['putStateDocument']> => {
      const input = statePutSchema.parse(supplied);
      validateStateValue(input.value, input.name);
      return write(input, { op: 'put' }, () => input.value);
    },
    patchStateDocument: async (supplied): ReturnType<IStateDocumentStore['patchStateDocument']> => {
      const input = parseStatePatchInput(supplied);
      return write(input, { op: 'patch', ops: input.ops }, prior =>
        applyStatePatch(prior?.value ?? {}, input.ops, input.name)
      );
    },
    deleteStateDocument: async (supplied): ReturnType<IStateDocumentStore['deleteStateDocument']> =>
      write(stateDeleteSchema.parse(supplied), { op: 'delete' }, () => null),
    listStateRevisions: async (
      project,
      name,
      options = {}
    ): ReturnType<IStateDocumentStore['listStateRevisions']> => {
      scope(project, name);
      const limit =
        options.limit === undefined ? undefined : z.number().int().positive().parse(options.limit);
      return (
        await query<RevisionRow>(
          `SELECT * FROM remote_agent_state_revisions WHERE project_key = $1 AND name = $2 ORDER BY revision DESC${limit === undefined ? '' : ' LIMIT $3'}`,
          limit === undefined ? [project, name] : [project, name, limit]
        )
      ).rows.map(hydrate);
    },
    pruneStateRevisions: async (days): ReturnType<IStateDocumentStore['pruneStateRevisions']> => {
      z.number().int().nonnegative().parse(days);
      const cutoff = new Date(Date.now() - days * 86400000).toISOString();
      // Tombstones are revision cursors; removing one would make a stale CAS valid after recreation.
      const result = await query(
        `DELETE FROM remote_agent_state_revisions
          WHERE created_at < $1 AND EXISTS (
            SELECT 1 FROM remote_agent_state_revisions newer WHERE newer.project_key = remote_agent_state_revisions.project_key
              AND newer.name = remote_agent_state_revisions.name AND newer.revision > remote_agent_state_revisions.revision
          )`,
        [cutoff]
      );
      return { count: result.rowCount };
    },
  };
}
