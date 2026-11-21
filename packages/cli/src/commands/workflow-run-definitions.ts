/**
 * Where a fresh `archon workflow run` reads its definitions, and the commit its worktree is
 * cut from. See `withLayeredDefinitions` for the rule.
 */
import { resolve } from 'node:path';
import * as git from '@archon/git';
import { findRepoRoot } from '@archon/git';
import type { LayeredDefinitionsInput } from '@archon/core/workflows/definition-source';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import type { PreparedWorkflowSource } from '@archon/workflows/run-source';
import type { RunDefinitions } from '@archon/workflows/schemas/run-metadata';
import { resolveWorkflowName } from '@archon/workflows/router';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
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
  if (options.adoptRunId !== undefined) return directoryPlan(cwd);
  const inPlace = inPlacePlan(cwd);
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
  return basePlan(host, cwd, options, base?.branch);
}

/** Base plus local, on `baseOverride` or the base the project resolves to. */
export async function basePlan(
  host: WorkflowHost,
  cwd: string,
  options: WorkflowRunOptions,
  baseOverride: string | undefined
): Promise<RunDefinitionsPlan> {
  const found = await findLaunchCodebase(host, cwd, options);
  return {
    kind: 'base',
    checkout: found.cwd,
    repoPath: found.codebase?.default_cwd ?? found.repoRoot ?? found.cwd,
    baseOverride,
    // An unregistered project's first run registers it with `--base-branch` as its default.
    defaultBranch: projectDefaultBranch(found.codebase, options),
  };
}

/** A directory read as it is, recording no definitions: an adopted lane's source. */
export function directoryPlan(root: string): RunDefinitionsPlan {
  return { kind: 'directory', root, definitions: undefined };
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

/** The registered default branch, or the one `--base-branch` registers the project with. */
export function projectDefaultBranch(
  codebase: { default_branch?: string | null } | null,
  options: Pick<WorkflowRunOptions, 'registrationBaseBranch'>
): string | undefined {
  return codebase?.default_branch?.trim() || options.registrationBaseBranch?.trim() || undefined;
}

/** An in-place run reads its checkout as it is; the checkout is its one commit. */
export function inPlacePlan(cwd: string): Extract<RunDefinitionsPlan, { kind: 'directory' }> {
  return {
    kind: 'directory',
    root: cwd,
    definitions: { from: 'checkout', checkout: resolve(cwd) },
  };
}

/**
 * Whether the named workflow, as the checkout holds it, pins `worktree.enabled: false`.
 * Read only when the base cannot be composed: an in-place workflow reads its checkout as
 * it is, so it never needs the base, and its run does not fail for want of one.
 */
export async function pinnedInPlace(
  host: WorkflowHost,
  cwd: string,
  workflowName: string
): Promise<boolean> {
  const { workflows } = await discoverWorkflowsWithConfig(
    cwd,
    host.deps.loadConfig,
    host.deps.providers
  );
  const found = resolveWorkflowName(
    workflowName,
    workflows.map(entry => entry.workflow)
  );
  return found?.worktree?.enabled === false;
}

/**
 * The plan a dry run reads its definitions by. A dry run reads no project registry, so it
 * takes the base from `--base`, else `worktree.baseBranch`, else `--base-branch`, else the
 * remote's default branch, and an item's landing branch is not read. Otherwise the same
 * rule as a real run.
 */
export async function previewPlan(
  cwd: string,
  options: WorkflowRunOptions
): Promise<RunDefinitionsPlan> {
  if (options.discoveryCwd !== undefined) {
    const root = resolve(options.discoveryCwd);
    return { kind: 'directory', root: options.discoveryCwd, definitions: { from: 'source', root } };
  }
  if (options.noWorktree || options.folder || (await findRepoRoot(cwd)) === null)
    return inPlacePlan(cwd);
  return {
    kind: 'base',
    checkout: cwd,
    repoPath: cwd,
    baseOverride: options.baseBranch?.trim() || undefined,
    defaultBranch: projectDefaultBranch(null, options),
  };
}
