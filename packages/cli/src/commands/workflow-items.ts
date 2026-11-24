/**
 * `archon workflow items`: the project's items with a run started in a window, each read
 * as `workflow runs --item` reads it, a page at a time. The host command behind the
 * `archon:script` `items()` export; `GET /api/items/window` returns the same document.
 */
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import {
  attentionQueueSource,
  projectRefForCodebase,
} from '@archon/core/operations/attention-queue';
import { findCodebaseForCheckoutPath } from '@archon/core/services/codebase-checkout-resolver';
import {
  ItemWindowQueryError,
  readItemWindow,
  type ItemWindowQuery,
} from '@archon/workflows/item-window';
import { writeJsonLine, writeStderr } from '../utils/stdout';
import { itemReadLines } from './workflow-item-text';
import { servedHosts } from '../utils/install-hosts';
import { inheritedWorkflowCodebase } from './workflow-shared';

export const WORKFLOW_ITEMS_USAGE =
  'Usage: archon workflow items [--since <duration|ISO>] [--until <ISO>] [--limit <n>] [--json]\n' +
  '       archon workflow items --after <cursor> [--limit <n>] [--json]';

async function refuse(json: boolean | undefined, message: string): Promise<number> {
  if (json) await writeJsonLine({ ok: false, error: message });
  else await writeStderr(`Error: ${message}\n`);
  return 1;
}

export async function workflowItemsCommand(
  host: WorkflowHost,
  cwd: string,
  query: ItemWindowQuery,
  json: boolean | undefined
): Promise<number> {
  // The project is found as `workflow runs --item` finds it: the selected one, else the checkout's.
  const codebase =
    (await inheritedWorkflowCodebase(host)) ??
    (await findCodebaseForCheckoutPath(cwd, host.records.codebases));
  if (!codebase) return refuse(json, 'items reads the items of one registered project.');
  const project = projectRefForCodebase(codebase);
  let page;
  try {
    page = await readItemWindow(
      attentionQueueSource(host.deps.store, host.records.isolation),
      project.key,
      query
    );
  } catch (error) {
    if (error instanceof ItemWindowQueryError) return refuse(json, error.message);
    throw error;
  }
  if (json) {
    await writeJsonLine(page);
    return 0;
  }
  console.log(
    `\nItems in ${project.name} with a run started from ${page.window.since} to ${page.window.until}:`
  );
  if (page.items.length === 0) console.log('  none');
  const served = await servedHosts();
  for (const read of page.items) console.log(`\n${itemReadLines(read, served).join('\n')}`);
  if (page.next !== null) console.log(`\nMore: archon workflow items --after ${page.next}`);
  console.log('');
  return 0;
}
