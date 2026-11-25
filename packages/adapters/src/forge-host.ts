/**
 * The server's reach into the forge seam: where it finds forge plugins and config, and the one
 * read the console needs, whether a change merged. The CLI does not come through here; it
 * builds its own `discoveryOptions` (packages/cli/src/commands/forge.ts).
 *
 * Imports only `@archon/forge` and `@archon/paths`, never this package's index, so a host
 * can load it without the chat adapters.
 */
import { randomUUID } from 'node:crypto';
import { getPluginsPath } from '@archon/paths';
import { getArchonConfigPath } from '@archon/paths/archon-paths';
import { discoverPlugins, type PluginDiscovery } from '@archon/forge/discovery';
import { dispatchForge } from '@archon/forge/dispatch';
import { readForgeConfig, sourceForgePlugins } from '@archon/forge/host-plugins';
import {
  type ForgeRequest,
  type ForgeResponse,
  forgeOperationAuditSchema,
  forgePrRecordSchema,
} from '@archon/forge/operations';
import { forgePluginConfigSchema } from '@archon/forge/plugin-config';
import type { PrRef } from '@archon/forge';

/**
 * The pull request a forge audit row recorded for `url`: the latest successful operation
 * whose result carries that pull request's record. The forge said which PR the URL is,
 * so nothing here parses the URL.
 */
export function prRefFromAudits(url: string, audits: readonly unknown[]): PrRef | null {
  for (const row of [...audits].reverse()) {
    const audit = forgeOperationAuditSchema.safeParse(row);
    if (!audit.success || !audit.data.result.ok) continue;
    const value: unknown = audit.data.result.result.value;
    if (typeof value !== 'object' || value === null || !('pr' in value)) continue;
    const pr = forgePrRecordSchema.safeParse(value.pr);
    if (pr.success && pr.data.url === url) return { repo: pr.data.repo, number: pr.data.number };
  }
  return null;
}

/**
 * Which change to ask about: the change at a URL, with the forge audit rows of the run that
 * recorded it, or the pull request on the item's run branches in the repository the project's
 * git `remote` resolves to (null when the project has none), for a run that named no URL.
 */
export type ChangeLookup =
  | { kind: 'url'; url: string; audits: readonly unknown[] }
  | { kind: 'branch'; remote: string | null };

export interface ChangeMergeState {
  /** The pull request's URL as the forge returned it; null when it could not say. */
  url: string | null;
  merged: boolean | 'unknown';
  mergedAt: string | null;
  /** The pull request's number when the forge named it; null when it could not. */
  number: number | null;
  /** Why the state is unknown; absent when the forge answered. */
  reason?: string;
}

type PrView = NonNullable<
  Extract<Extract<ForgeResponse, { ok: true }>['result'], { op: 'pr.view' }>['value']
>;
type Ask = (request: ForgeRequest) => Promise<ForgeResponse>;
/** A pull request the forge showed, or why it could not be found. */
type Found = { view: PrView } | { reason: string };

const unknown = (reason: string): ChangeMergeState => ({
  url: null,
  merged: 'unknown',
  mergedAt: null,
  number: null,
  reason,
});
const failed = (response: Extract<ForgeResponse, { ok: false }>): string =>
  `${response.error.kind}: ${response.error.message}`;

/** The pull request `ref` names, by number. */
async function viewByNumber(ask: Ask, ref: PrRef): Promise<Found> {
  const response = await ask({
    op: 'pr.view',
    operationId: randomUUID(),
    selector: { kind: 'number', ref },
  });
  if (!response.ok) return { reason: failed(response) };
  if (response.result.op !== 'pr.view' || response.result.value === null)
    return { reason: 'the forge found no such pull request' };
  return { view: response.result.value };
}

/**
 * The repository a change lookup searches: the one the forge resolves the change's web URL
 * to, or, for a branch lookup, the project's git remote.
 */
async function repoOf(
  ask: Ask,
  lookup: ChangeLookup
): Promise<{ repo: PrRef['repo'] } | { reason: string }> {
  const remote = lookup.kind === 'url' ? lookup.url : lookup.remote;
  if (remote === null) return { reason: 'the project has no remote to look the change up in' };
  const resolved = await ask({
    op: 'resolve',
    operationId: randomUUID(),
    remote,
    ...(lookup.kind === 'url' ? { web: true as const } : {}),
  });
  if (!resolved.ok) return { reason: failed(resolved) };
  if (resolved.result.op !== 'resolve' || resolved.result.value.kind !== 'resolved')
    return {
      reason:
        lookup.kind === 'url'
          ? 'no forge plugin resolves this change'
          : "no forge plugin resolves the project's remote",
    };
  return { repo: resolved.result.value.repo };
}

/**
 * The pull request opened from one of `branches` (the item's runs' recorded branches,
 * newest first) in `repo`, in any state, that `accept` takes. A branch with no pull
 * request, or one `accept` refuses, is passed over, and a forge failure ends the search as
 * unknown rather than as not found.
 */
async function viewByBranch(
  ask: Ask,
  repo: PrRef['repo'],
  branches: readonly string[],
  accept: (view: PrView) => boolean
): Promise<Found> {
  for (const head of branches) {
    const response = await ask({
      op: 'pr.view',
      operationId: randomUUID(),
      selector: { kind: 'head', repo, headRepo: repo, head, state: 'any' },
    });
    if (!response.ok) return { reason: failed(response) };
    if (response.result.op !== 'pr.view') return { reason: 'the forge answered another operation' };
    const view = response.result.value;
    if (view !== null && accept(view)) return { view };
  }
  return { reason: "no pull request on the item's run branches is this change" };
}

/** The pull request a lookup names, through the forge. */
async function findChange(
  ask: Ask,
  lookup: ChangeLookup,
  branches: () => Promise<readonly string[]>
): Promise<Found> {
  const ref = lookup.kind === 'url' ? prRefFromAudits(lookup.url, lookup.audits) : null;
  if (ref !== null) return viewByNumber(ask, ref);
  const heads = await branches();
  if (heads.length === 0) return { reason: 'no forge record or run branch names this change' };
  const repo = await repoOf(ask, lookup);
  if ('reason' in repo) return repo;
  return viewByBranch(ask, repo.repo, heads, view =>
    lookup.kind === 'url' ? view.pr.url === lookup.url : true
  );
}

/** The plugins one lookup dispatches through. */
type Discovery = () => Promise<PluginDiscovery>;

/** How a read reaches the forge: its plugins (`forgePluginsOnce`) and the environment. */
export interface ForgeHostOptions {
  plugins: Discovery;
  env: NodeJS.ProcessEnv;
  dispatch?: typeof dispatchForge;
}

/** The dispatch a read asks the forge through. */
function asker(options: ForgeHostOptions): Ask {
  return async request =>
    (
      await (options.dispatch ?? dispatchForge)(request, {
        discovery: await options.plugins(),
        env: options.env,
        credentialEnv: options.env,
      })
    ).response;
}

/**
 * The forge plugins under `archonHome`, discovered once for the process and shared by every
 * lookup, since a discovery runs each plugin's metadata handshake: discovering per lookup
 * stalled a cold server's first read for seconds (#137). Concurrent callers share the one in
 * flight. A discovery that failed, or left a plugin unavailable, is not kept once it settles,
 * so the next lookup discovers again rather than answering `unknown` until a restart. A plugin
 * added or changed after that needs a server restart to be seen: the read is display-only,
 * and runs and the CLI discover for themselves.
 */
export function forgePluginsOnce(
  archonHome: string,
  env: NodeJS.ProcessEnv,
  discover: typeof discoverPlugins = discoverPlugins
): Discovery {
  let held: Promise<PluginDiscovery> | null = null;
  const drop = (settled: Promise<PluginDiscovery>): void => {
    if (held === settled) held = null;
  };
  return () => {
    if (held !== null) return held;
    const started = readForgeConfig(getArchonConfigPath(archonHome)).then(config =>
      discover({
        config: forgePluginConfigSchema.parse(config),
        env,
        pluginsDir: getPluginsPath(archonHome),
        sourcePlugins: sourceForgePlugins(),
      })
    );
    held = started;
    started.then(
      found => {
        if (found.unavailable.length > 0) drop(started);
      },
      () => {
        drop(started);
      }
    );
    return started;
  };
}

/**
 * Which pull request a change is and whether it merged, asked of its forge with `pr.view`.
 * For a URL lookup, when one of the recording run's forge audit rows names its pull
 * request, that is asked by number. When none does (an earlier run opened it), `branches`
 * gives the item's runs' recorded branches, newest first, read only then, and the pull
 * request on one of them whose URL is the change is taken. A branch lookup (the run named
 * no URL) takes the first pull request on those branches in the project remote's
 * repository, whatever its URL. Plugins come from `plugins` (`forgePluginsOnce`).
 * Never throws: a failure, a failed discovery included, is `unknown` with its reason.
 * Nothing is audited, as nothing here belongs to a run.
 */
export async function changeMergeState(
  lookup: ChangeLookup,
  branches: () => Promise<readonly string[]>,
  options: ForgeHostOptions
): Promise<ChangeMergeState> {
  try {
    const ask = asker(options);
    const found = await findChange(ask, lookup, branches);
    if ('reason' in found) return unknown(found.reason);
    const { pr, timestamps } = found.view;
    return pr.state === 'merged'
      ? { url: pr.url, merged: true, mergedAt: timestamps?.merged_at ?? null, number: pr.number }
      : { url: pr.url, merged: false, mergedAt: null, number: pr.number };
  } catch (error) {
    return unknown((error as Error).message);
  }
}

/** An issue as the forge shows it, or why it could not say. */
export type WorkItemAnswer =
  | { number: number; title: string; state: 'open' | 'closed'; url: string }
  | { number: number; unknown: string };

/**
 * Issue `number` in the repository the project's git `remote` resolves to, asked of its forge
 * with `workitem.view`. Never throws: a failure, a failed plugin search included, is
 * `unknown` with its reason. Nothing is audited, as nothing here belongs to a run.
 */
export async function viewWorkItem(
  number: number,
  remote: string | null,
  options: ForgeHostOptions
): Promise<WorkItemAnswer> {
  try {
    const ask = asker(options);
    const repo = await repoOf(ask, { kind: 'branch', remote });
    if ('reason' in repo) return { number, unknown: repo.reason };
    const response = await ask({
      op: 'workitem.view',
      operationId: randomUUID(),
      ref: { repo: repo.repo, number },
    });
    if (!response.ok) return { number, unknown: failed(response) };
    if (response.result.op !== 'workitem.view')
      return { number, unknown: 'the forge answered another operation' };
    const { title, state, url } = response.result.value;
    return { number, title, state, url };
  } catch (error) {
    return { number, unknown: (error as Error).message };
  }
}
