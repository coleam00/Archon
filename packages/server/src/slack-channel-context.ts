/**
 * Resolves what a Slack channel means to Archon: its human-readable name, and
 * the project a brand-new thread in it should bind to.
 *
 * Extracted from the Slack intake path in index.ts so the policy is unit
 * testable — index.ts is large and has no tests (same rationale as
 * discord-mention.ts / github-auth-bootstrap.ts). Kept free of I/O and logging:
 * both dependencies are injected, and an unresolvable mapping is REPORTED back
 * for the caller to log rather than logged here.
 */
import type { SlackConfig } from '@archon/core';
import type { SlackChannelNameResult } from '@archon/adapters';

export interface SlackChannelContextDeps {
  /** Usually `SlackAdapter.resolveChannelName` (cached `conversations.info`). */
  readonly resolveChannelName: (channelId: string) => Promise<SlackChannelNameResult>;
  /** Usually `codebaseDb.findCodebaseByName`. */
  readonly findCodebaseByName: (name: string) => Promise<{ id: string } | null>;
}

export interface SlackChannelContextResult {
  /** Resolved channel name; undefined when disabled, a DM, or unresolvable. */
  readonly channelName?: string;
  /**
   * Why `channelName` is absent, so the assistant can explain rather than
   * guess. Undefined whenever `channelName` is present. Mirrors
   * `MessageOrigin.channelNameStatus` in @archon/core.
   */
  readonly channelNameStatus?: 'disabled' | 'unavailable' | 'dm';
  /** Project to bind a NEW conversation to; undefined when unmapped or disabled. */
  readonly codebaseId?: string;
  /**
   * Set when `channelProjects` named a project that is not registered — a
   * config typo, or a project registered later. The caller logs this; binding
   * is skipped and the conversation is created unbound (never blocking).
   */
  readonly unresolvedProject?: string;
}

/**
 * Look up a project name in the channel → project map.
 *
 * The map comes from YAML that is cast, not schema-validated, so both the map
 * and its values are checked defensively. Name keys are matched
 * case-insensitively (Slack lower-cases channel names, but a hand-written
 * config may not); channel IDs are matched exactly, as Slack IDs are
 * case-sensitive.
 */
function lookupProjectName(
  channelProjects: Record<string, string> | undefined,
  key: string | undefined,
  caseInsensitive: boolean
): string | undefined {
  if (!channelProjects || typeof channelProjects !== 'object' || !key) return undefined;

  const exact = channelProjects[key];
  if (typeof exact === 'string' && exact.trim()) return exact.trim();
  if (!caseInsensitive) return undefined;

  const lowered = key.toLowerCase();
  for (const [mapKey, mapValue] of Object.entries(channelProjects)) {
    if (mapKey.toLowerCase() === lowered && typeof mapValue === 'string' && mapValue.trim()) {
      return mapValue.trim();
    }
  }
  return undefined;
}

/**
 * Resolve channel name + project binding for an inbound Slack message.
 *
 * The two flags are independent by design:
 * - `useChannelName` (default true) decides whether the channel NAME is looked
 *   up at all — it keys the map when on, and gates channel awareness either way.
 * - `autoSetProject` (default true) decides only whether a mapping BINDS a new
 *   conversation, so awareness keeps working with binding turned off.
 *
 * A failed name lookup or an unregistered project degrades to "no binding" so
 * the message still flows — but that's this function's OWN logic, not a
 * blanket guarantee. Dependency calls are awaited un-wrapped: `resolveChannelName`
 * is documented never to throw, but `findCodebaseByName` is a raw DB call and
 * its rejection propagates uncaught. The caller is responsible for catching
 * infrastructure failures from the injected dependencies.
 */
export async function resolveSlackChannelContext(
  channelId: string,
  slack: SlackConfig | undefined,
  deps: SlackChannelContextDeps
): Promise<SlackChannelContextResult> {
  const useChannelName = slack?.useChannelName !== false;
  const autoSetProject = slack?.autoSetProject !== false;

  let channelName: string | undefined;
  let channelNameStatus: SlackChannelContextResult['channelNameStatus'];
  if (useChannelName) {
    const resolved = await deps.resolveChannelName(channelId);
    if (resolved.kind === 'name') channelName = resolved.name;
    else channelNameStatus = resolved.kind;
  } else {
    channelNameStatus = 'disabled';
  }

  if (!autoSetProject) return { channelName, channelNameStatus };

  const projectName = lookupProjectName(
    slack?.channelProjects,
    useChannelName ? channelName : channelId,
    useChannelName
  );
  if (!projectName) return { channelName, channelNameStatus };

  const codebase = await deps.findCodebaseByName(projectName);
  if (!codebase) {
    return { channelName, channelNameStatus, unresolvedProject: projectName };
  }

  return { channelName, channelNameStatus, codebaseId: codebase.id };
}
