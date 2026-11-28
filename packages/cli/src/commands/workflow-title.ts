/**
 * `archon workflow title`: set what an item is called. Every read of the item returns it
 * beside the key. Setting it again replaces it. The item is written on first use, so a
 * title can be set before the item has a run.
 */
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { assertItemKey, itemTitleSchema } from '@archon/workflows/schemas/workflow-run';
import { writeJsonLine } from '../utils/stdout';
import { type ItemTarget, NoRunItemError, resolveItemTarget } from './item-target';

export const WORKFLOW_TITLE_USAGE =
  'Usage: archon workflow title --item <key>|--item-of <run-id> --text <title> [--json]';

export type WorkflowTitleRequest = ItemTarget & { text: string };

export async function workflowTitleCommand(
  host: WorkflowHost,
  cwd: string,
  request: WorkflowTitleRequest,
  json: boolean | undefined
): Promise<number> {
  try {
    const title = itemTitleSchema.safeParse(request.text);
    if (!title.success) throw new Error(title.error.issues[0]?.message ?? 'Not a title');
    const { projectKey, key } = await resolveItemTarget(host, cwd, request);
    assertItemKey(key);
    const item = await host.deps.store.recordItemTitle({ projectKey, key, title: title.data });
    if (json) await writeJsonLine(item);
    else console.log(`Item ${item.key} is titled: ${title.data}`);
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
