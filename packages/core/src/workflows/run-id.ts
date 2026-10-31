import type { IWorkflowStore } from '@archon/workflows/store';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';

export async function findProjectRunsByReference(
  store: Pick<IWorkflowStore, 'findWorkflowRunsByIdPrefix'>,
  reference: string,
  codebaseId: string
): Promise<WorkflowRun[]> {
  const matches = await store.findWorkflowRunsByIdPrefix(reference, codebaseId);
  // SQLite generates undashed IDs; PostgreSQL generates dashed UUIDs.
  if (matches.length === 0 && /^[0-9a-f]{32}$/i.test(reference)) {
    const id = reference.toLowerCase();
    const dashedId = `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
    return store.findWorkflowRunsByIdPrefix(dashedId, codebaseId);
  }
  return matches;
}

export function isFullRunId(reference: string): boolean {
  return /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i.test(
    reference
  );
}

export function uniqueRunReferenceMatch(
  matches: readonly WorkflowRun[],
  reference: string
): WorkflowRun | null {
  const run = matches.length === 1 ? matches[0] : undefined;
  if (
    !run ||
    (isFullRunId(reference) &&
      run.id.replaceAll('-', '').toLowerCase() !== reference.replaceAll('-', '').toLowerCase())
  ) {
    return null;
  }
  return run;
}
