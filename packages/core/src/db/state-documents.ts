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
async function insert(query: Query, project: string, revision: StateRevision): Promise<boolean> {
  const writer = revision.writer;
  const result = await query(
    `INSERT INTO remote_agent_state_revisions
    (project_key, name, revision, value, operation, writer_kind, writer_run_id, writer_node_path, writer_identity, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (project_key, name, revision) DO NOTHING`,
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
  return result.rowCount === 1;
}

export function createSqlStateDocumentStore(
  db: Pick<IDatabase, 'query' | 'withTransaction'>
): IStateDocumentStore {
  const write = async (
    input: Parameters<IStateDocumentStore['deleteStateDocument']>[0],
    operation: StateRevision['operation'],
    compute: (prior: StateRevision | null) => StateRevision['value']
  ): Promise<StateRevision> => {
    for (let attempt = 0; attempt <= 5; attempt++) {
      const result = await db.withTransaction(async query => {
        const prior = await latest(query, input.project, input.name);
        const actual = prior?.revision ?? 0;
        if (input.ifRevision !== undefined && input.ifRevision !== actual)
          throw new StateRevisionConflictError(input.name, input.ifRevision, actual);
        const value = compute(prior);
        const next: StateRevision = {
          name: input.name,
          revision: actual + 1,
          value,
          operation,
          writer: input.writer,
          createdAt: new Date().toISOString(),
        };
        return { written: await insert(query, input.project, next), next, actual };
      });
      if (result.written) return result.next;
      if (input.ifRevision !== undefined || attempt === 5) {
        const current = await latest(db.query.bind(db), input.project, input.name);
        throw new StateRevisionConflictError(
          input.name,
          input.ifRevision ?? result.actual,
          current?.revision ?? 0
        );
      }
      // Spread competing patch retries so eight writers need not collide in every round.
      await new Promise(resolve => setTimeout(resolve, Math.random() * 10 * (attempt + 1)));
    }
    throw new Error('Unreachable state write');
  };
  return {
    getStateDocument: async (
      project,
      name
    ): ReturnType<IStateDocumentStore['getStateDocument']> => {
      scope(project, name);
      const row = await latest(db.query.bind(db), project, name);
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
        await db.query<RevisionRow>(
          `SELECT * FROM remote_agent_state_revisions WHERE project_key = $1 AND name = $2 ORDER BY revision DESC${limit === undefined ? '' : ' LIMIT $3'}`,
          limit === undefined ? [project, name] : [project, name, limit]
        )
      ).rows.map(hydrate);
    },
    listStateDocuments: async (
      project,
      options = {}
    ): ReturnType<IStateDocumentStore['listStateDocuments']> => {
      z.string().min(1).parse(project);
      const rows = await db.query<RevisionRow>(
        `SELECT r.* FROM remote_agent_state_revisions r
        WHERE project_key = $1 AND value IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM remote_agent_state_revisions newer WHERE newer.project_key = r.project_key AND newer.name = r.name AND newer.revision > r.revision
        ) ORDER BY name`,
        [project]
      );
      return rows.rows.filter(row => row.name.startsWith(options.prefix ?? '')).map(hydrate);
    },
    pruneStateRevisions: async (days): ReturnType<IStateDocumentStore['pruneStateRevisions']> => {
      z.number().int().nonnegative().parse(days);
      const cutoff = new Date(Date.now() - days * 86400000).toISOString();
      // Tombstones are revision cursors; removing one would make a stale CAS valid after recreation.
      return db.withTransaction(async query => {
        const result = await query(
          `DELETE FROM remote_agent_state_revisions
          WHERE created_at < $1 AND EXISTS (
            SELECT 1 FROM remote_agent_state_revisions newer WHERE newer.project_key = remote_agent_state_revisions.project_key
              AND newer.name = remote_agent_state_revisions.name AND newer.revision > remote_agent_state_revisions.revision
          )`,
          [cutoff]
        );
        return { count: result.rowCount };
      });
    },
  };
}
