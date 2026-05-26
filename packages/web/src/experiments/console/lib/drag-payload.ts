import type { Run } from '../primitives/run';

/** Typed payload carried by a run-card drag transfer. */
export interface DragPayload {
  runId: string;
  projectId: string;
  workflow: string;
  message: string;
}

/** MIME type key used in dataTransfer; keeps all drag participants in sync. */
export const DRAG_MIME = 'application/archon-run';

/** Encode the fields needed by the drop zone into a JSON string. */
export function encodeDragPayload(run: Run): string {
  return JSON.stringify({
    runId: run.id,
    projectId: run.projectId,
    workflow: run.workflow,
    message: run.userMessage,
  });
}

/** Decode a raw dataTransfer string. Returns null if the JSON is malformed or
 *  any required field is missing/wrong type — safe to call on untrusted input. */
export function decodeDragPayload(raw: string): DragPayload | null {
  try {
    const obj = JSON.parse(raw) as unknown;
    if (obj === null || typeof obj !== 'object') return null;
    const o = obj as Record<string, unknown>;
    if (
      typeof o.runId !== 'string' ||
      typeof o.projectId !== 'string' ||
      typeof o.workflow !== 'string' ||
      typeof o.message !== 'string'
    ) {
      return null;
    }
    return { runId: o.runId, projectId: o.projectId, workflow: o.workflow, message: o.message };
  } catch {
    return null;
  }
}
