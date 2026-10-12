import {
  applyStatePatch,
  statePutSchema,
  parseStatePatchInput,
  stateDeleteSchema,
  validateStateValue,
  StateRevisionConflictError,
  type IStateDocumentStore,
  type StateRevision,
} from '@archon/workflows/state-document-store';

export function createInMemoryStateDocumentStore(): IStateDocumentStore & {
  backdate(project: string, name: string): Promise<void>;
} {
  const documents = new Map<string, StateRevision[]>();
  const key = (project: string, name: string): string => JSON.stringify([project, name]);
  const rows = (project: string, name: string): StateRevision[] =>
    documents.get(key(project, name)) ?? [];
  const commit = (
    input: Parameters<IStateDocumentStore['deleteStateDocument']>[0],
    operation: StateRevision['operation'],
    value: StateRevision['value']
  ): StateRevision => {
    const history = rows(input.project, input.name);
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
    documents.set(key(input.project, input.name), [...history, structuredClone(next)]);
    return structuredClone(next);
  };
  return {
    getStateDocument: async (
      project,
      name
    ): ReturnType<IStateDocumentStore['getStateDocument']> => {
      const row = rows(project, name).at(-1);
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
        { op: 'patch', ops: input.ops },
        applyStatePatch(rows(input.project, input.name).at(-1)?.value ?? {}, input.ops, input.name)
      );
    },
    deleteStateDocument: async (supplied): ReturnType<IStateDocumentStore['deleteStateDocument']> =>
      commit(stateDeleteSchema.parse(supplied), { op: 'delete' }, null),
    listStateRevisions: async (
      project,
      name,
      options
    ): ReturnType<IStateDocumentStore['listStateRevisions']> =>
      structuredClone([...rows(project, name)].reverse().slice(0, options?.limit)),
    listStateDocuments: async (
      project,
      options
    ): ReturnType<IStateDocumentStore['listStateDocuments']> =>
      structuredClone(
        [...documents.entries()]
          .flatMap(([id, history]) => {
            const row = history.at(-1);
            if (!row) throw new Error('Empty state history');
            return id === key(project, row.name) &&
              row.value !== null &&
              row.name.startsWith(options?.prefix ?? '')
              ? [row]
              : [];
          })
          .sort((a, b) => a.name.localeCompare(b.name))
      ),
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
    backdate: async (project, name): Promise<void> => {
      for (const row of rows(project, name)) row.createdAt = '2000-01-01T00:00:00.000Z';
    },
  };
}
