/**
 * `archon workflow link`: record a link from one item of this project to another, or end
 * one. A link is a directed relation the engine stores and reports; the item read shows it
 * from both sides (`workflow runs --item`). The engine acts on no link.
 */
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { projectRefForCodebase } from '@archon/core/operations/attention-queue';
import { endItemLink, recordItemLink } from '@archon/core/operations/item-links';
import { findCodebaseForCheckoutPath } from '@archon/core/services/codebase-checkout-resolver';
import {
  ItemLinkEndedError,
  ItemLinkNotFoundError,
  ItemLinkOutsideProjectError,
  ItemLinkSelfError,
  itemLinkKindSchema,
  type ItemLink,
} from '@archon/workflows/schemas/item-link';
import { cliActor } from '../utils/calling-node';
import { writeJsonLine } from '../utils/stdout';
import { inheritedWorkflowCodebase } from './workflow-shared';

const KINDS = itemLinkKindSchema.options.join('|');

export const WORKFLOW_LINK_USAGE =
  `Usage: archon workflow link --item <key> --kind <${KINDS}> --to <key> [--as <name>] [--json]\n` +
  '       archon workflow link --end <link-id> [--as <name>] [--json]';

export type WorkflowLinkRequest =
  | { item: string; kind: string; to: string; as?: string }
  | { end: string; as?: string };

/** A kind outside the three; refused before anything is written. */
class UnknownLinkKindError extends Error {
  constructor(kind: string) {
    super(
      `Unknown link kind '${kind}'. A link is one of: ${itemLinkKindSchema.options.join(', ')}.`
    );
    this.name = 'UnknownLinkKindError';
  }
}

async function link(
  host: WorkflowHost,
  cwd: string,
  request: WorkflowLinkRequest,
  env: NodeJS.ProcessEnv
): Promise<{ link: ItemLink; created: boolean }> {
  const actor = cliActor(request.as, env);
  const selected = await inheritedWorkflowCodebase(host);
  // An end names its link by id. Under a selected project the link must start at one of
  // that project's items; without one it is not scoped, as a ruling id is not.
  if ('end' in request)
    return {
      link: await endItemLink(
        host.deps.store,
        {
          linkId: request.end,
          ...(selected ? { projectKey: projectRefForCodebase(selected).key } : {}),
        },
        actor,
        'cli'
      ),
      created: false,
    };
  const kind = itemLinkKindSchema.safeParse(request.kind);
  if (!kind.success) throw new UnknownLinkKindError(request.kind);
  // The project comes from the checkout, the same way `workflow runs --item` finds it.
  const codebase = selected ?? (await findCodebaseForCheckoutPath(cwd, host.records.codebases));
  if (!codebase) throw new Error('--item names an item in one registered project.');
  return recordItemLink(
    host.deps.store,
    {
      projectKey: projectRefForCodebase(codebase).key,
      fromKey: request.item,
      toKey: request.to,
      kind: kind.data,
    },
    actor,
    'cli'
  );
}

/** The fixed code of a refusal a caller acts on; any other failure reports its message. */
function refusalCode(error: unknown): string | undefined {
  if (error instanceof UnknownLinkKindError) return 'unknown_kind';
  if (error instanceof ItemLinkSelfError) return 'self_link';
  if (error instanceof ItemLinkNotFoundError) return 'not_found';
  if (error instanceof ItemLinkEndedError) return 'already_ended';
  if (error instanceof ItemLinkOutsideProjectError) return 'outside_project';
  return undefined;
}

function linkText({ link, created }: { link: ItemLink; created: boolean }): string {
  if (link.ended) return `Link ${link.id} ended.`;
  const fact = `${link.from.key} ${link.kind} ${link.to.key}`;
  return created
    ? `Link ${link.id} recorded: ${fact}.`
    : `Link ${link.id} already recorded: ${fact}.`;
}

export async function workflowLinkCommand(
  host: WorkflowHost,
  cwd: string,
  request: WorkflowLinkRequest,
  json: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  try {
    const result = await link(host, cwd, request, env);
    if (json) await writeJsonLine({ ...result.link, created: result.created });
    else console.log(linkText(result));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) await writeJsonLine({ ok: false, error: refusalCode(error) ?? message });
    else console.error(`Error: ${message}`);
    return 1;
  }
}
