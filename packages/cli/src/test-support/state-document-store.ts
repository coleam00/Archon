import {
  applyStatePatch,
  statePutSchema,
  parseStatePatchInput,
  stateDeleteSchema,
  stateNamePrefixSchema,
  statePatchOperation,
  stateScopeKey,
  validateStateValue,
  StateRevisionConflictError,
  type IStateDocumentStore,
  type StateRevision,
  type StateScope,
} from '@archon/workflows/state-document-store';

export function createInMemoryStateDocumentStore(): IStateDocumentStore & {
  backdate(scope: StateScope, name: string): Promise<void>;
} {
  const documents = new Map<string, StateRevision[]>();
  const key = (scope: StateScope, name: string): string =>
    JSON.stringify([stateScopeKey(scope), name]);
  const rows = (scope: StateScope, name: string): StateRevision[] =>
    documents.get(key(scope, name)) ?? [];
  /** Each document's latest revision under the prefix, ordered by name. */
  const latestRevisions = (scope: StateScope, options?: { prefix?: string }): StateRevision[] => {
    const prefix = stateNamePrefixSchema.parse(options?.prefix ?? '');
    const scopeKey = stateScopeKey(scope);
    return [...documents.entries()]
      .flatMap(([id, history]) => {
        const [owner, name] = JSON.parse(id) as [string, string];
        const last = history.at(-1);
        return owner === scopeKey && name.startsWith(prefix) && last ? [structuredClone(last)] : [];
      })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  };
  const commit = (
    input: Parameters<IStateDocumentStore['deleteStateDocument']>[0],
    operation: StateRevision['operation'],
    value: StateRevision['value']
  ): StateRevision => {
    const history = rows(input.scope, input.name);
    const actual = history.at(-1)?.revision ?? 0;
    if (input.ifRevision !== undefined && input.ifRevision !== actual)
      throw new StateRevisionConflictError(input.name, input.ifRevision, actual);
    validateStateValue(value, input.name);
    const next: StateRevision = {
      name: input.name,
      revision: actual + 1,
      value,
      operation,
      writer: input.writer,
      createdAt: new Date().toISOString(),
    };
    documents.set(key(input.scope, input.name), [...history, structuredClone(next)]);
    return structuredClone(next);
  };
  return {
    getStateDocument: async (scope, name): ReturnType<IStateDocumentStore['getStateDocument']> => {
      const row = rows(scope, name).at(-1);
      return row && row.value !== null ? structuredClone(row) : null;
    },
    putStateDocument: async (supplied): ReturnType<IStateDocumentStore['putStateDocument']> => {
      const input = statePutSchema.parse(supplied);
      return commit(input, { op: 'put' }, input.value);
    },
    patchStateDocument: async (supplied): ReturnType<IStateDocumentStore['patchStateDocument']> => {
      const input = parseStatePatchInput(supplied);
      return commit(
        input,
        statePatchOperation(input),
        applyStatePatch(rows(input.scope, input.name).at(-1)?.value ?? {}, input.ops, input.name)
      );
    },
    deleteStateDocument: async (supplied): ReturnType<IStateDocumentStore['deleteStateDocument']> =>
      commit(stateDeleteSchema.parse(supplied), { op: 'delete' }, null),
    listStateRevisions: async (
      scope,
      name,
      options
    ): ReturnType<IStateDocumentStore['listStateRevisions']> =>
      structuredClone([...rows(scope, name)].reverse().slice(0, options?.limit)),
    listStateDocuments: async (
      scope,
      options
    ): ReturnType<IStateDocumentStore['listStateDocuments']> =>
      latestRevisions(scope, options).map(last => ({
        name: last.name,
        revision: last.revision,
        updatedAt: last.createdAt,
        writer: last.writer,
        deleted: last.value === null,
      })),
    getStateDocuments: async (
      scope,
      options
    ): ReturnType<IStateDocumentStore['getStateDocuments']> =>
      latestRevisions(scope, options).filter(last => last.value !== null),
    pruneStateRevisions: async (days): ReturnType<IStateDocumentStore['pruneStateRevisions']> => {
      const cutoff = Date.now() - days * 86400000;
      let count = 0;
      for (const [id, history] of documents) {
        const last = history.at(-1);
        if (!last) throw new Error('Empty state history');
        const keep = history.filter(row => row === last || Date.parse(row.createdAt) >= cutoff);
        count += history.length - keep.length;
        if (keep.length) documents.set(id, keep);
        else documents.delete(id);
      }
      return { count };
    },
    backdate: async (scope, name): Promise<void> => {
      for (const row of rows(scope, name)) row.createdAt = '2000-01-01T00:00:00.000Z';
    },
  };
}
