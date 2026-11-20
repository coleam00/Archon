/**
 * Where a fresh `archon workflow run` reads its definitions, and the commit its worktree is
 * cut from. See `withLayeredDefinitions` for the rule.
 */
import { resolve } from 'node:path';
import * as git from '@archon/git';
import type { LayeredDefinitionsInput } from '@archon/core/workflows/definition-source';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import type { PreparedWorkflowSource } from '@archon/workflows/run-source';
import type { RunDefinitions } from '@archon/workflows/schemas/run-metadata';
import { findLaunchCodebase } from './workflow-isolation';
import { resolveLaunchBase } from './workflow-run-config';
import type { WorkflowRunOptions } from './workflow-shared';

/**
 * Where a fresh run's definitions come from: a directory read as it is (an explicit
 * `--workflow-source`, the checkout of an in-place or folder run, an adopted lane's
 * source, which recaptures later), or the base branch with the checkout's uncommitted
 * changes on top.
 */
export type RunDefinitionsPlan =
  | { kind: 'directory'; root: string; definitions: RunDefinitions | undefined }
  | ({ kind: 'base' } & LayeredDefinitionsInput);

/**
 * The definitions plan a fresh run starts with. A worktree run is planned on the base
 * branch `--base` or `--item`'s landing branch names; a lane that turns out to run in
 * place, or on another base, settles it again (`settleRunDefinitions`).
 */
export async function runDefinitionsPlan(
  host: WorkflowHost,
  cwd: string,
  options: WorkflowRunOptions
): Promise<RunDefinitionsPlan> {
  if (options.discoveryCwd !== undefined) {
    const root = resolve(options.discoveryCwd);
    return { kind: 'directory', root: options.discoveryCwd, definitions: { from: 'source', root } };
  }
  const checkout = { kind: 'directory', root: cwd } as const;
  if (options.adoptRunId !== undefined) return { ...checkout, definitions: undefined };
  const inPlace = {
    ...checkout,
    definitions: { from: 'checkout', checkout: resolve(cwd) },
  } as const;
  if (options.noWorktree || options.folder) return inPlace;
  const found = await findLaunchCodebase(host, cwd, options);
  if (found.codebase?.kind === 'folder' || (!found.codebase && !found.repoRoot)) return inPlace;
  const flagBase = options.baseBranch?.trim() || undefined;
  const base = await resolveLaunchBase(
    host,
    options.item,
    { isContinuation: false, flagBase, wantsIsolation: true },
    found.codebase,
    undefined
  );
  return {
    kind: 'base',
    checkout: found.cwd,
    repoPath: found.codebase?.default_cwd ?? found.repoRoot ?? found.cwd,
    baseOverride: base?.branch,
    defaultBranch: found.codebase?.default_branch?.trim() || undefined,
  };
}

/** Cut a run whose definitions came from the base branch at the commit they were read at. */
export function definitionsStartCommit(
  source: PreparedWorkflowSource | undefined
): { startCommit: { commit: string; branch: git.BranchName } } | Record<string, never> {
  const definitions = source?.definitions;
  return definitions?.from === 'base'
    ? { startCommit: { commit: definitions.commit, branch: git.toBranchName(definitions.branch) } }
    : {};
}
