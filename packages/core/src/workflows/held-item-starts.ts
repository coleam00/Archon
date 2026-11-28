/**
 * Which item each held binding start names, for the store adapter's held-start reads. Its own
 * module so a test reaches it without the adapter's database and provider imports.
 */
import { createLogger } from '@archon/paths';
import type { HeldStart } from '@archon/workflows/resource-start-store';
import type { ItemNamingHeldStart } from '@archon/workflows/schemas/item-held-start';
import { CheckoutCodebaseAmbiguousError } from '../services/codebase-checkout-resolver';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.held-item-starts');
  return cachedLog;
}

/** Where the held-start reads get the held starts and the project a checkout is in. */
export interface HeldStartSources {
  listHeldStarts: () => Promise<readonly HeldStart[]>;
  projectKeyOf: (cwd: string) => Promise<string | null>;
}

type PlacedHeldStart = Extract<ItemNamingHeldStart, { projectKey: string }>;

/**
 * The held binding starts that name an item, each with the item it names. A binding is
 * resolved to a project only when it is prepared, so its checkout decides the project here
 * the way it will then; only a start whose key matches is resolved.
 *
 * `all` is the read of many items at once: a start whose checkout matches more than one
 * registered codebase is logged and listed unplaced, with the reason, so one such checkout
 * cannot fail a read of every item (#286) and the start still shows on the item reads its
 * key names. `naming` is the read of one item's starts, which a decision depends on, so it
 * still fails on that ambiguity. Any other failure throws from both.
 */
export function heldStartReads(sources: HeldStartSources): {
  all: () => Promise<ItemNamingHeldStart[]>;
  naming: (itemKey: string) => Promise<PlacedHeldStart[]>;
} {
  const read = async (
    keyMatches: (itemKey: string) => boolean,
    listAmbiguous: boolean
  ): Promise<ItemNamingHeldStart[]> => {
    const held: ItemNamingHeldStart[] = [];
    for (const start of await sources.listHeldStarts()) {
      if (start.kind !== 'trigger' || start.itemKey === null || start.cwd === null) continue;
      if (!keyMatches(start.itemKey)) continue;
      const { receiptId, bindingId, hostId, workflow, receivedAt, itemKey, cwd } = start;
      const fields = { receiptId, bindingId, hostId, workflow, receivedAt, itemKey };
      let projectKey: string | null;
      try {
        projectKey = await sources.projectKeyOf(cwd);
      } catch (error) {
        if (!listAmbiguous || !(error instanceof CheckoutCodebaseAmbiguousError)) throw error;
        getLog().warn({ err: error, receiptId, cwd }, 'held_start_project_ambiguous');
        held.push({ ...fields, projectKey: null, unplaced: error.message });
        continue;
      }
      if (projectKey !== null) held.push({ ...fields, projectKey });
    }
    return held;
  };
  return {
    all: () => read(() => true, true),
    naming: async itemKey =>
      (await read(key => key === itemKey, false)).filter(
        (start): start is PlacedHeldStart => start.projectKey !== null
      ),
  };
}
