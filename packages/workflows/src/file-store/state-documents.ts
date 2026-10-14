import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  applyStatePatch,
  statePutSchema,
  parseStatePatchInput,
  stateDeleteSchema,
  stateDocumentNameSchema,
  stateNamePrefixSchema,
  statePatchOperation,
  stateRevisionSchema,
  stateScopeSchema,
  stateScopeKey,
  validateStateValue,
  StateRevisionConflictError,
  type IStateDocumentStore,
  type StateRevision,
  type StateScope,
} from '../state-document-store';
import { commit, readJson } from './commit';

const nameRecordSchema = z.object({ scope: stateScopeSchema, name: stateDocumentNameSchema });
type NameRecord = z.infer<typeof nameRecordSchema>;
function directory(scope: StateScope, name: string): string {
  stateDocumentNameSchema.parse(name);
  return `state/${createHash('sha256')
    .update(JSON.stringify([stateScopeKey(scope), name]))
    .digest('hex')}`;
}
async function entries(path: string): Promise<string[] | undefined> {
  try {
    return await readdir(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}
export function createFileStateDocumentStore(root: string): IStateDocumentStore {
  async function revisions(scope: StateScope, name: string): Promise<number[]> {
    const dir = directory(scope, name);
    const files = await entries(join(root, dir));
    if (files === undefined) return [];
    const record = nameRecordSchema.parse(await readJson(join(root, dir, 'name.json')));
    if (record.name !== name || stateScopeKey(record.scope) !== stateScopeKey(scope))
      throw new Error(`State name record differs: ${dir}`);
    if (
      files.some(
        file =>
          file !== 'name.json' &&
          !/^[1-9][0-9]*\.json$/.test(file) &&
          !/^(name|[1-9][0-9]*)\.json\.publish\.tmp$/.test(file)
      )
    )
      throw new Error(`Invalid state file: ${dir}`);
    const numbers = files
      .filter(file => /^[1-9][0-9]*\.json$/.test(file))
      .map(file => Number(file.slice(0, -5)));
    if (!numbers.length || numbers.some(number => !Number.isSafeInteger(number)))
      throw new Error(`Invalid state revisions: ${dir}`);
    return numbers.sort((a, b) => b - a);
  }
  async function read(scope: StateScope, name: string, revision: number): Promise<StateRevision> {
    const row = stateRevisionSchema.parse(
      await readJson(join(root, directory(scope, name), `${revision}.json`))
    );
    if (row.name !== name || row.revision !== revision)
      throw new Error('State revision identity differs');
    return row;
  }
  async function latest(scope: StateScope, name: string): Promise<StateRevision | null> {
    const revision = (await revisions(scope, name))[0];
    return revision === undefined ? null : read(scope, name, revision);
  }
  async function documents(): Promise<NameRecord[]> {
    const result: NameRecord[] = [];
    for (const dir of (await entries(join(root, 'state'))) ?? []) {
      const record = nameRecordSchema.parse(await readJson(join(root, 'state', dir, 'name.json')));
      if (directory(record.scope, record.name) !== `state/${dir}`)
        throw new Error('State directory identity differs');
      result.push(record);
    }
    return result;
  }
  function query<T>(call: () => Promise<T>): Promise<T> {
    return commit(root, [], async () => ({ result: await call(), changes: {} }));
  }
  function write(
    input: Parameters<IStateDocumentStore['deleteStateDocument']>[0],
    operation: StateRevision['operation'],
    compute: (prior: StateRevision | null) => StateRevision['value']
  ): Promise<StateRevision> {
    return commit(root, [], async () => {
      const prior = await latest(input.scope, input.name);
      const actual = prior?.revision ?? 0;
      if (input.ifRevision !== undefined && input.ifRevision !== actual)
        throw new StateRevisionConflictError(input.name, input.ifRevision, actual);
      const row: StateRevision = {
        name: input.name,
        revision: actual + 1,
        value: compute(prior),
        operation,
        writer: input.writer,
        createdAt: new Date().toISOString(),
      };
      const dir = directory(input.scope, input.name);
      return {
        result: row,
        changes: {
          immutableDocuments: {
            [`${dir}/name.json`]: { scope: input.scope, name: input.name },
            [`${dir}/${row.revision}.json`]: row,
          },
        },
      };
    });
  }
  return {
    getStateDocument: (scope, name) =>
      query(async () => {
        const row = await latest(scope, name);
        return row?.value === null ? null : row;
      }),
    putStateDocument: async supplied => {
      const input = statePutSchema.parse(supplied);
      validateStateValue(input.value, input.name);
      return write(input, { op: 'put' }, () => input.value);
    },
    patchStateDocument: async supplied => {
      const input = parseStatePatchInput(supplied);
      return write(input, statePatchOperation(input), prior =>
        applyStatePatch(prior?.value ?? {}, input.ops, input.name)
      );
    },
    deleteStateDocument: async supplied =>
      write(stateDeleteSchema.parse(supplied), { op: 'delete' }, () => null),
    listStateRevisions: async (scope, name, options = {}) => {
      const limit =
        options.limit === undefined ? undefined : z.number().int().positive().parse(options.limit);
      return query(async () => {
        const numbers = (await revisions(scope, name)).slice(0, limit);
        return Promise.all(numbers.map(number => read(scope, name, number)));
      });
    },
    listStateDocuments: async (scope, options = {}) => {
      const key = stateScopeKey(scope);
      const prefix = stateNamePrefixSchema.parse(options.prefix ?? '');
      return query(async () => {
        const result = [];
        for (const record of await documents()) {
          if (stateScopeKey(record.scope) !== key || !record.name.startsWith(prefix)) continue;
          const row = await latest(record.scope, record.name);
          if (!row) throw new Error('State document has no revisions');
          result.push({
            name: row.name,
            revision: row.revision,
            updatedAt: row.createdAt,
            writer: row.writer,
            deleted: row.value === null,
          });
        }
        return result.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      });
    },
    pruneStateRevisions: async days => {
      z.number().int().nonnegative().parse(days);
      return commit(root, [], async () => {
        const cutoff = new Date(Date.now() - days * 86400000).toISOString();
        const deleted: string[] = [];
        for (const { scope, name } of await documents()) {
          for (const number of (await revisions(scope, name)).slice(1)) {
            if ((await read(scope, name, number)).createdAt < cutoff)
              deleted.push(`${directory(scope, name)}/${number}.json`);
          }
        }
        return { result: { count: deleted.length }, changes: { deleteDocuments: deleted } };
      });
    },
  };
}
