import {
  applyStatePatch,
  statePutSchema,
  parseStatePatchInput,
  stateDeleteSchema,
  stateDocumentNameSchema,
  stateDocumentSummarySchema,
  stateNamePrefixSchema,
  statePatchOperation,
  stateRevisionSchema,
  stateScopeKey,
  validateStateValue,
  StateRevisionConflictError,
  type IStateDocumentStore,
  type StateRevision,
  type StateScope,
  type StateWriter,
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
  writer_via: string | null;
  created_at: string | Date;
}
// The shipped CHECK admits only 'run' and 'operator' as writer_kind, so 'operator' stays
// the stored token for any write outside a run; writer_via holds its surface. Rows from
// before writer_via existed were all written through the CLI.
function storedWriter(
  writer: StateWriter
): Pick<RevisionRow, 'writer_kind' | 'writer_run_id' | 'writer_node_path' | 'writer_via'> {
  return writer.kind === 'run'
    ? {
        writer_kind: 'run',
        writer_run_id: writer.runId,
        writer_node_path: writer.nodePath,
        writer_via: null,
      }
    : {
        writer_kind: 'operator',
        writer_run_id: null,
        writer_node_path: null,
        writer_via: writer.via,
      };
}
function hydrateWriter(row: Omit<RevisionRow, 'value' | 'operation'>): unknown {
  return row.writer_kind === 'run'
    ? { kind: 'run', runId: row.writer_run_id, nodePath: row.writer_node_path }
    : { kind: 'surface', via: row.writer_via ?? 'cli' };
}
function hydrate(row: RevisionRow): StateRevision {
  return stateRevisionSchema.parse({
    name: row.name,
    revision: row.revision,
    value: row.value === null ? null : (JSON.parse(row.value) as unknown),
    operation: JSON.parse(row.operation) as unknown,
    writer: hydrateWriter(row),
    createdAt: toHydratedTimestamp(row.created_at).toISOString(),
  });
}
function scope(target: StateScope, name: string): string {
  stateDocumentNameSchema.parse(name);
  return stateScopeKey(target);
}
async function latest(query: Query, project: string, name: string): Promise<StateRevision | null> {
  const result = await query<RevisionRow>(
    'SELECT * FROM remote_agent_state_revisions WHERE project_key = $1 AND name = $2 ORDER BY revision DESC LIMIT 1',
    [project, name]
  );
  return result.rows[0] ? hydrate(result.rows[0]) : null;
}
async function insert(query: Query, project: string, revision: StateRevision): Promise<void> {
  const writer = storedWriter(revision.writer);
  await query(
    `INSERT INTO remote_agent_state_revisions
    (project_key, name, revision, value, operation, writer_kind, writer_run_id, writer_node_path, writer_via, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      project,
      revision.name,
      revision.revision,
      revision.value === null ? null : JSON.stringify(revision.value),
      JSON.stringify(revision.operation),
      writer.writer_kind,
      writer.writer_run_id,
      writer.writer_node_path,
      writer.writer_via,
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
    const project = stateScopeKey(input.scope);
    // Writers to one document serialize, so a write never loses a race for its revision
    // and only an explicit ifRevision mismatch fails. SQLite has one writer: a commit that
    // read a stale snapshot fails with SQLITE_BUSY_SNAPSHOT and the adapter reruns this
    // block. PostgreSQL READ COMMITTED needs a lock that also covers the first revision,
    // before any row exists to lock.
    return db.withTransaction(async txQuery => {
      if (db.dialect === 'postgres')
        await txQuery('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          JSON.stringify(['state-document', project, input.name]),
        ]);
      const prior = await latest(txQuery, project, input.name);
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
      await insert(txQuery, project, next);
      return next;
    });
  };
  /** Each document's latest revision under the prefix, ordered by name. */
  const latestRevisions = async <T extends { name: string }>(
    target: StateScope,
    options: { prefix?: string },
    columns: string,
    filter: string
  ): Promise<T[]> => {
    const project = stateScopeKey(target);
    const prefix = stateNamePrefixSchema.parse(options.prefix ?? '');
    // substr, not LIKE: `_` is a legal name character and a LIKE wildcard.
    const rows = await query<T>(
      `SELECT ${columns}
        FROM remote_agent_state_revisions latest_revision
        WHERE project_key = $1 AND substr(name, 1, $2) = $3
          AND revision = (SELECT MAX(revision) FROM remote_agent_state_revisions other
            WHERE other.project_key = latest_revision.project_key AND other.name = latest_revision.name)${filter}`,
      [project, prefix.length, prefix]
    );
    // Sorted here by code unit: PostgreSQL's ORDER BY follows the database collation.
    return [...rows.rows].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  };
  return {
    getStateDocument: async (target, name): ReturnType<IStateDocumentStore['getStateDocument']> => {
      const row = await latest(query, scope(target, name), name);
      return row?.value === null ? null : row;
    },
    putStateDocument: async (supplied): ReturnType<IStateDocumentStore['putStateDocument']> => {
      const input = statePutSchema.parse(supplied);
      validateStateValue(input.value, input.name);
      return write(input, { op: 'put' }, () => input.value);
    },
    patchStateDocument: async (supplied): ReturnType<IStateDocumentStore['patchStateDocument']> => {
      const input = parseStatePatchInput(supplied);
      return write(input, statePatchOperation(input), prior =>
        applyStatePatch(prior?.value ?? {}, input.ops, input.name)
      );
    },
    deleteStateDocument: async (supplied): ReturnType<IStateDocumentStore['deleteStateDocument']> =>
      write(stateDeleteSchema.parse(supplied), { op: 'delete' }, () => null),
    listStateRevisions: async (
      target,
      name,
      options = {}
    ): ReturnType<IStateDocumentStore['listStateRevisions']> => {
      const project = scope(target, name);
      const limit =
        options.limit === undefined ? undefined : z.number().int().positive().parse(options.limit);
      return (
        await query<RevisionRow>(
          `SELECT * FROM remote_agent_state_revisions WHERE project_key = $1 AND name = $2 ORDER BY revision DESC${limit === undefined ? '' : ' LIMIT $3'}`,
          limit === undefined ? [project, name] : [project, name, limit]
        )
      ).rows.map(hydrate);
    },
    listStateDocuments: async (
      target,
      options = {}
    ): ReturnType<IStateDocumentStore['listStateDocuments']> => {
      const rows = await latestRevisions<
        Omit<RevisionRow, 'value' | 'operation'> & {
          deleted: boolean | number;
        }
      >(
        target,
        options,
        `name, revision, writer_kind, writer_run_id, writer_node_path, writer_via, created_at,
            (value IS NULL) AS deleted`,
        ''
      );
      return rows.map(row =>
        stateDocumentSummarySchema.parse({
          name: row.name,
          revision: row.revision,
          updatedAt: toHydratedTimestamp(row.created_at).toISOString(),
          writer: hydrateWriter(row),
          deleted: Boolean(row.deleted),
        })
      );
    },
    getStateDocuments: async (
      target,
      options = {}
    ): ReturnType<IStateDocumentStore['getStateDocuments']> =>
      (await latestRevisions<RevisionRow>(target, options, '*', ' AND value IS NOT NULL')).map(
        hydrate
      ),
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
