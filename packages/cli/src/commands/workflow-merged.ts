/**
 * `archon workflow merged`: record that an item's change merged, as the forge reported it
 * to the caller. The caller decides which change belongs to which item; the engine records
 * the fact once, and every later item read carries it.
 */
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import {
  itemMergeAtSchema,
  itemMergeChangeSchema,
  itemMergeCommitSchema,
  type ItemMergeRecorded,
} from '@archon/workflows/schemas/item-merge';
import { readCallingNode } from '../utils/calling-node';
import { writeJsonLine } from '../utils/stdout';
import { type ItemTarget, NoRunItemError, resolveItemTarget } from './item-target';

export const WORKFLOW_MERGED_USAGE =
  'Usage: archon workflow merged --item <key>|--item-of <run-id> --change <ref> --at <ISO> [--commit <sha>] [--json]';

export type WorkflowMergedRequest = ItemTarget & {
  change: string;
  at: string;
  commit?: string;
};

class MergeNotFoundError extends Error {}

async function record(
  host: WorkflowHost,
  cwd: string,
  request: WorkflowMergedRequest,
  env: NodeJS.ProcessEnv
): Promise<{ key: string } & ItemMergeRecorded> {
  if (!itemMergeChangeSchema.safeParse(request.change).success)
    throw new Error('--change must be 1 to 2048 characters.');
  if (!itemMergeAtSchema.safeParse(request.at).success)
    throw new Error('--at must be an ISO time with an offset, such as 2026-11-02T10:00:00Z.');
  if (request.commit !== undefined && !itemMergeCommitSchema.safeParse(request.commit).success)
    throw new Error('--commit must be a full lowercase commit hash.');
  const { projectKey, key } = await resolveItemTarget(host, cwd, request);
  const fromRun = env.WORKFLOW_ID ? readCallingNode(env.WORKFLOW_ID, env) : null;
  const recorded = await host.deps.store.recordItemMerge({
    projectKey,
    key,
    change: request.change,
    commit: request.commit ?? null,
    at: request.at,
    via: 'cli',
    fromRun,
  });
  if (recorded === null) throw new MergeNotFoundError(`No item '${key}' in this project.`);
  return { key, ...recorded };
}

export async function workflowMergedCommand(
  host: WorkflowHost,
  cwd: string,
  request: WorkflowMergedRequest,
  json: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  try {
    const { key, ...result } = await record(host, cwd, request, env);
    if (json) await writeJsonLine(result);
    else if (result.recorded) console.log(`Item ${key} recorded as merged.`);
    else
      console.log(
        `Item ${key} was already recorded as merged (${result.merge.change}); kept that.`
      );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json)
      await writeJsonLine({
        ok: false,
        error:
          error instanceof MergeNotFoundError
            ? 'not_found'
            : error instanceof NoRunItemError
              ? 'no_item'
              : message,
      });
    else console.error(`Error: ${message}`);
    return 1;
  }
}
