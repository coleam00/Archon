import { randomUUID } from 'node:crypto';
import { createLogger, getPluginsPath } from '@archon/paths';
import { getArchonConfigPath, getArchonHome } from '@archon/paths/archon-paths';
import type { Codebase } from '@archon/core';
import type { ForgeError, ForgeRequest } from '@archon/forge/operations';
import { discoverPlugins, type PluginDiscovery } from '@archon/forge/discovery';
import { dispatchForge, type ForgeDispatchResult } from '@archon/forge/dispatch';
import { readForgeConfig, sourceForgePlugins } from '@archon/forge/host-plugins';
import { forgePluginConfigSchema } from '@archon/forge/plugin-config';
import type { ProjectForge } from '../routes/schemas/forge.schemas';

export type ProjectCodebase = Pick<Codebase, 'id' | 'kind' | 'repository_url'>;

export interface ProjectForgeDeps {
  discover: () => Promise<PluginDiscovery>;
  dispatch: (
    request: ForgeRequest,
    options: { discovery: PluginDiscovery; credentialEnv?: NodeJS.ProcessEnv }
  ) => Promise<Pick<ForgeDispatchResult, 'response'>>;
  /** The environment the forge credential is read from for this project and user. */
  credentialEnv: (
    codebase: ProjectCodebase,
    userId: string | undefined
  ) => Promise<NodeJS.ProcessEnv>;
  now: () => Date;
}

export type ProjectForgeReader = (
  codebase: ProjectCodebase,
  userId: string | undefined
) => Promise<ProjectForge>;

/** The window of an overview's "merged since" and "closed since" counts. */
const SINCE_MS = 7 * 24 * 60 * 60 * 1000;
/** How long one read answers later requests, so a page of readers costs one forge call. */
const CACHE_MS = 60_000;

/**
 * The forge as `archon forge` reaches it: the `forge:` block of the Archon config, the
 * installed plugins and, from a source checkout, the bundled plugin.
 */
export function hostForgeAccess(
  env: NodeJS.ProcessEnv = process.env
): Pick<ProjectForgeDeps, 'discover' | 'dispatch'> {
  return {
    discover: async () => {
      const archonHome = getArchonHome(env);
      return discoverPlugins({
        config: forgePluginConfigSchema.parse(
          await readForgeConfig(getArchonConfigPath(archonHome))
        ),
        env,
        pluginsDir: getPluginsPath(archonHome),
        sourcePlugins: sourceForgePlugins(),
      });
    },
    dispatch: (request, options) => dispatchForge(request, { ...options, env }),
  };
}

/**
 * The error a client may see. Dispatch gives an `exitCode` only to the failure of a
 * plugin process, whose message can carry what the plugin printed, so that message is
 * replaced. Every other message is the host's or the forge's own, as `archon forge`
 * prints it: a broken `gh` login is `process_failed` too, and names its repair.
 */
function publicError({ kind, message, exitCode }: ForgeError): {
  kind: ForgeError['kind'];
  message: string;
} {
  return {
    kind,
    message: exitCode === undefined ? message : 'The forge plugin could not be run.',
  };
}

async function readProjectForge(
  deps: ProjectForgeDeps,
  codebase: ProjectCodebase,
  remote: string,
  userId: string | undefined
): Promise<ProjectForge> {
  const log = createLogger('server.project-forge');
  const unresolved = (failure: ForgeError): ProjectForge => {
    const error = publicError(failure);
    log.warn({ codebaseId: codebase.id, ...error }, 'project_forge.unresolved');
    return { kind: 'unresolved', error };
  };

  let discovery: PluginDiscovery;
  try {
    discovery = await deps.discover();
  } catch (error) {
    log.warn({ err: error, codebaseId: codebase.id }, 'project_forge.discovery_failed');
    return unresolved({ kind: 'process_failed', message: 'forge plugin discovery failed' });
  }
  const resolved = (
    await deps.dispatch({ operationId: randomUUID(), op: 'resolve', remote }, { discovery })
  ).response;
  if (!resolved.ok) return unresolved(resolved.error);
  if (resolved.result.op !== 'resolve')
    return unresolved({
      kind: 'invalid_response',
      message: 'The forge answered another operation',
    });
  const forge = resolved.result.value;
  if (forge.kind === 'none') return { kind: 'none' };

  const metadata = discovery.plugins.find(
    plugin => plugin.metadata.name === forge.plugin.name
  )?.metadata;
  const identity = {
    kind: 'forge' as const,
    forge: {
      name: metadata?.display?.name ?? forge.forge,
      ...(metadata?.display?.icon ? { icon: metadata.display.icon } : {}),
    },
    repo: { host: forge.repo.host, path: forge.repo.path },
    plugin: { name: forge.plugin.name, version: forge.plugin.version },
  };
  const failed = (failure: ForgeError, remedy?: string): ProjectForge => {
    const error = publicError(failure);
    log.warn(
      { codebaseId: codebase.id, exitCode: failure.exitCode, ...error },
      'project_forge.overview_failed'
    );
    return {
      ...identity,
      overview: { status: 'failed', error, ...(remedy ? { remedy } : {}) },
    };
  };

  let credentialEnv: NodeJS.ProcessEnv;
  try {
    credentialEnv = await deps.credentialEnv(codebase, userId);
  } catch (error) {
    log.warn({ err: error, codebaseId: codebase.id }, 'project_forge.credential_failed');
    // No plugin remedy: the plugin's is about its own token, and this credential is Archon's
    // to resolve. The cause may name an account or an installation, so it stays in the log.
    return failed({
      kind: 'no_credential',
      message:
        'Archon could not resolve the forge credential for this project. The server log has the cause.',
    });
  }
  const overview = (
    await deps.dispatch(
      {
        operationId: randomUUID(),
        op: 'repo.overview',
        repo: forge.repo,
        since: new Date(deps.now().getTime() - SINCE_MS).toISOString(),
      },
      { discovery, credentialEnv }
    )
  ).response;
  if (!overview.ok) {
    const { kind } = overview.error;
    return failed(
      overview.error,
      kind === 'unsupported_op' || kind === 'no_credential' ? metadata?.remedies?.[kind] : undefined
    );
  }
  if (overview.result.op !== 'repo.overview')
    return failed({ kind: 'invalid_response', message: 'The forge answered another operation' });
  return {
    ...identity,
    overview: {
      status: 'ok',
      syncedAt: deps.now().toISOString(),
      value: overview.result.value,
    },
  };
}

/** Only a settled answer is worth repeating: a failure must show its repair on the next read. */
function cacheable(forge: ProjectForge): boolean {
  return forge.kind === 'none' || (forge.kind === 'forge' && forge.overview.status === 'ok');
}

/**
 * Reads a project's forge, answering repeats for the same project, remote and user from
 * one read for a minute. The user is part of the key because the credential is the
 * user's: one user's counts and access never answer another's request.
 */
export function createProjectForgeReader(deps: ProjectForgeDeps): ProjectForgeReader {
  const cache = new Map<string, { expires: number; read: Promise<ProjectForge> }>();
  return (codebase, userId) => {
    const remote = codebase.repository_url;
    if (codebase.kind === 'folder' || !remote) return Promise.resolve({ kind: 'none' });
    const key = JSON.stringify([codebase.id, remote, userId ?? null]);
    const at = deps.now().getTime();
    for (const [stale, entry] of cache) if (entry.expires <= at) cache.delete(stale);
    const cached = cache.get(key);
    if (cached) return cached.read;

    const entry = {
      expires: at + CACHE_MS,
      read: readProjectForge(deps, codebase, remote, userId),
    };
    cache.set(key, entry);
    const drop = (): void => {
      if (cache.get(key) === entry) cache.delete(key);
    };
    void entry.read.then(forge => {
      if (!cacheable(forge)) drop();
    }, drop);
    return entry.read;
  };
}
