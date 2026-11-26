/**
 * `archon workflow priority`: give an item priority, or clear it with `--clear`. A queued
 * start of an item with priority, or of an item `part_of` one, goes ahead of every ordinary
 * queued start on its resource and host at the next drain; a slot already held is never
 * taken. A work order may be given priority before its members have runs.
 */
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import type { ItemPriority } from '@archon/workflows/schemas/item-priority';
import { assertItemKey } from '@archon/workflows/schemas/workflow-run';
import { writeJsonLine } from '../utils/stdout';
import { type ItemTarget, NoRunItemError, resolveItemTarget } from './item-target';

export const WORKFLOW_PRIORITY_USAGE =
  'Usage: archon workflow priority --item <key>|--item-of <run-id> [--clear] [--json]';

export type WorkflowPriorityRequest = ItemTarget & { clear: boolean };

/** How the CLI names where an item's priority comes from: `own`, `part_of <key>`, or both. */
export function prioritySourceText(priority: ItemPriority): string {
  return [
    ...(priority.own ? ['own'] : []),
    ...priority.inheritedFrom.map(item => `part_of ${item.key}`),
  ].join(', ');
}

async function write(
  host: WorkflowHost,
  cwd: string,
  request: WorkflowPriorityRequest
): Promise<{ key: string; priority: ItemPriority | null }> {
  const { projectKey, key } = await resolveItemTarget(host, cwd, request);
  assertItemKey(key);
  const { store } = host.deps;
  if (!request.clear) return { key, priority: await store.setItemPriority({ projectKey, key }) };
  const cleared = await store.clearItemPriority({ projectKey, key });
  if (cleared === null) throw new Error(`No item '${key}' in project '${projectKey}'.`);
  return { key, priority: cleared.priority };
}

export async function workflowPriorityCommand(
  host: WorkflowHost,
  cwd: string,
  request: WorkflowPriorityRequest,
  json: boolean | undefined
): Promise<number> {
  try {
    const { key, priority } = await write(host, cwd, request);
    if (json) await writeJsonLine({ priority });
    else if (priority === null) console.log(`Item ${key} has no priority.`);
    else if (request.clear)
      // Its own flag is gone, but a work order it is part_of still gives it priority.
      console.log(
        `Item ${key} is still priority through ${priority.inheritedFrom.map(item => item.key).join(', ')}; clear it there.`
      );
    else console.log(`Item ${key} has priority (${prioritySourceText(priority)}).`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json)
      await writeJsonLine({
        ok: false,
        error: error instanceof NoRunItemError ? 'no_item' : message,
      });
    else console.error(`Error: ${message}`);
    return 1;
  }
}
