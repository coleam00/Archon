import { resolve } from 'path';
import { stat } from 'fs/promises';
import { RUN_PROJECT_CONFLICT_FLAGS } from '../dispatch-guards';
import { DETACHED_RUN_OWNER_ENV, DETACHED_LAUNCH_TOKEN_ENV } from '../utils/detached-run-control';
import { matchProjectClaim } from '../utils/project-selector';
import { fail } from './context';
import type { WorkflowRoute } from './workflow';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { WorkflowRunOptions } from '../commands/workflow-shared';

/** True when `path` exists and is a directory (used to validate `--workflow-source`). */
async function isPathDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** The first refusal among the worktree flags `workflow run` cannot combine. */
function worktreeFlagConflict(values: Record<string, unknown>): string | undefined {
  const branchName = values.branch as string | undefined;
  const fromBranch =
    (values.from as string | undefined) ?? (values['from-branch'] as string | undefined);
  const noWorktree = values['no-worktree'] as boolean | undefined;
  if (branchName !== undefined && noWorktree) {
    return (
      'Error: --branch and --no-worktree are mutually exclusive.\n' +
      '  --branch creates an isolated worktree (safe).\n' +
      '  --no-worktree runs directly in your repo (no isolation).\n' +
      'Use one or the other.'
    );
  }
  if (noWorktree && fromBranch !== undefined) {
    return (
      'Error: --from/--from-branch has no effect with --no-worktree.\n' +
      'Remove --from or drop --no-worktree.'
    );
  }
  if (noWorktree && values.base !== undefined) {
    return 'Error: --base has no effect with --no-worktree.\nRemove --base or drop --no-worktree.';
  }
  return undefined;
}

// `--workflow-source` picks the authoring directory of a fresh run.
function workflowSourceConflict(values: Record<string, unknown>): string | undefined {
  if (values.container) {
    // A container run executes inside the container, which mounts the folder
    // project and nothing else. The capture lives outside that mount, so a
    // separate source root could be frozen but never read — the run would
    // fail looking for its own commands. Refuse the combination rather than
    // ship a flag that silently does not apply.
    return (
      'Error: --workflow-source and --container are mutually exclusive.\n' +
      '  A container run reads source from the project it mounts.\n' +
      '  Run without --container to execute source from another directory.'
    );
  }
  return undefined;
}

/** Resolves `--workflow-source`, or returns the exit code of its refusal. */
async function resolveWorkflowSource(route: WorkflowRoute): Promise<string | undefined | 1> {
  const { values, json } = route;
  const workflowSourceFlag = values['workflow-source'] as string | undefined;
  if (workflowSourceFlag === undefined) return undefined;
  const conflict = workflowSourceConflict(values);
  if (conflict) return await fail(json, conflict);
  const workflowSource = resolve(workflowSourceFlag);
  if (!(await isPathDirectory(workflowSource))) {
    return await refuseRunStartup(
      route,
      `Error: --workflow-source is not a directory: ${workflowSource}\n` +
        '  Point it at the checkout holding .archon/workflows/.'
    );
  }
  return workflowSource;
}

async function refuseRunStartup(
  { host, values, json }: WorkflowRoute,
  message: string
): Promise<1> {
  const { recordDetachedChildStartupFailure } = await import('../commands/workflow-detach');
  await recordDetachedChildStartupFailure(
    host,
    {
      detachedRunId: values['internal-detached-run-id'] as string | undefined,
      detachedProcessOwner: process.env[DETACHED_RUN_OWNER_ENV] === '1',
      launchToken: process.env[DETACHED_LAUNCH_TOKEN_ENV],
    },
    new Error(message)
  );
  return await fail(json, message);
}

async function resolveRunProject(route: WorkflowRoute): Promise<string | undefined | 1> {
  const { values, host } = route;
  const project = values.project as string | undefined;
  if (project === undefined) return undefined;
  const refuse = (message: string): Promise<1> => refuseRunStartup(route, message);
  for (const flag of RUN_PROJECT_CONFLICT_FLAGS) {
    if (values[flag] !== undefined && values[flag] !== false) {
      return await refuse(`Error: --project cannot be combined with --${flag}.`);
    }
  }
  try {
    const selected = matchProjectClaim(await host.records.codebases.listCodebaseClaims(), project);
    if (!selected) {
      return await refuse(
        `Error: Project '${project}' is not registered. Use archon project list to find a registered repository.`
      );
    }
    const codebase = await host.records.codebases.getCodebase(selected.id);
    if (!codebase) return await refuse(`Error: Project '${project}' no longer exists.`);
    if (codebase.kind !== 'repo') {
      return await refuse(
        'Error: --project requires a registered repository; folder projects run from their registered directory.'
      );
    }
    return codebase.id;
  } catch (error) {
    return await refuse(
      `Error: Cannot select registered project '${project}': ${error instanceof Error ? error.message : String(error)}\nUse archon project list to find a registered repository.`
    );
  }
}

/**
 * Parse `--input-file name=path` with the `--input` grammar and resolve each path from the
 * invocation's `--cwd`, as `--config` is. The cwd the run receives is normalized to the
 * repository root, so resolving later would read `<root>/item.txt` for `--cwd <root>/briefs`.
 */
async function resolveInputFilePaths(
  cwd: string,
  assignments: string[] | undefined
): Promise<Record<string, string> | undefined> {
  if (!assignments) return undefined;
  const { parseInputAssignments } = await import('@archon/workflows/workflow-inputs');
  return Object.fromEntries(
    Object.entries(parseInputAssignments(assignments, 'path')).map(([name, path]) => [
      name,
      resolve(cwd, path),
    ])
  );
}

function buildRunOptions(
  { values, cwd, json, detachedRunConfig }: WorkflowRoute,
  workflowSource: string | undefined,
  codebaseId: string | undefined,
  inputFiles: Record<string, string> | undefined
) {
  return {
    codebaseId,
    branchName: values.branch as string | undefined,
    fromBranch:
      (values.from as string | undefined) ?? (values['from-branch'] as string | undefined),
    baseBranch: values.base as string | undefined,
    registrationBaseBranch: values['base-branch'] as string | undefined,
    adoptRunId: values.adopt as string | undefined,
    supersedesRunId: values.supersedes as string | undefined,
    item: values.item as string | undefined,
    // `--workflow-source` selects WHERE the workflow is read from; `--cwd`
    // continues to select what it acts on. Reusing `discoveryCwd` keeps one
    // internal concept: the directory discovery searches, which the run then
    // freezes as its source.
    discoveryCwd: workflowSource,
    noWorktree: values['no-worktree'] as boolean | undefined,
    folder: values.folder as boolean | undefined,
    container: values.container as boolean | undefined,
    quiet: values.quiet as boolean | undefined,
    verbose: values.verbose as boolean | undefined,
    // Stable scope for persist_session across separate CLI invocations. Without
    // it each run gets a fresh conversation UUID, so persisted sessions never
    // resume between runs (they only resume within chat/REST, which reuse a
    // conversation). Pass the same id on each run to opt into cross-run resume.
    conversationId: values['conversation-id'] as string | undefined,
    detach: values.detach as boolean | undefined,
    noWait: values['no-wait'] as boolean | undefined,
    json,
    dryRun: values['dry-run'] as boolean | undefined,
    stubsPath: values.stubs as string | undefined,
    stubsInitPath: values['stubs-init'] as string | undefined,
    defaultStubs: values['default-stubs'] as boolean | undefined,
    execCode: values['exec-code'] as boolean | undefined,
    pauseAtGates: values['pause-at-gates'] as boolean | undefined,
    // Raw `name=value` assignments; parsed at the invocation gate (#2554).
    inputs: values.input as string[] | undefined,
    inputFiles,
    modelAssignments: values.model as string[] | undefined,
    configPath: typeof values.config === 'string' ? resolve(cwd, values.config) : undefined,
    configFromRun: values['config-from-run'] as string | undefined,
    detachedRunConfig,
    detachedRunId: values['internal-detached-run-id'] as string | undefined,
    detachedWorktreeIdentifier: values['internal-detached-worktree-identifier'] as
      | string
      | undefined,
  };
}

export async function runWorkflowRun(route: WorkflowRoute): Promise<number> {
  const { positionals, values, json } = route;
  const workflowName = positionals[2];
  if (!workflowName) {
    if (values.supersedes !== undefined) return await runRestart(route);
    return await fail(
      json,
      'Usage: archon workflow run <name> [message]  (or: archon workflow run --supersedes <run-id>)'
    );
  }
  const userMessage = positionals.slice(3).join(' ') || '';
  const worktreeConflict = worktreeFlagConflict(values);
  if (worktreeConflict) return await fail(json, worktreeConflict);
  const codebaseId = await resolveRunProject(route);
  if (codebaseId === 1) return 1;
  const workflowSource = await resolveWorkflowSource(route);
  if (workflowSource === 1) return 1;
  const inputFiles = await resolveInputFilePaths(
    route.cwd,
    values['input-file'] as string[] | undefined
  );
  await route.commands.workflowRunCommand(
    route.host,
    route.effectiveCwd,
    workflowName,
    userMessage,
    buildRunOptions(route, workflowSource, codebaseId, inputFiles)
  );
  return 0;
}

/** The flags whose values a nameless `--supersedes` takes from the run's record. */
const RESTART_RECORD_FLAGS = [
  'input',
  'input-file',
  'workflow-source',
  'adopt',
  'from',
  'from-branch',
] as const;

/** The first flag the nameless `--supersedes` form refuses, as its refusal. */
function restartFlagConflict(values: Record<string, unknown>): string | undefined {
  const supplied = RESTART_RECORD_FLAGS.find(flag => values[flag] !== undefined);
  if (supplied) {
    return (
      `Error: --supersedes without a workflow name takes --${supplied} from the run it supersedes.\n` +
      `  Name the workflow to pass --${supplied}.`
    );
  }
  // The detached child rebuilds its command from this argv, which names no workflow.
  if (values.detach) {
    return 'Error: --detach needs the workflow name; the nameless --supersedes form runs in the foreground.';
  }
  return worktreeFlagConflict(values);
}

/**
 * The directory a restart starts from. Without `--project` it is the failed run's project:
 * the invoking directory when that resolves to the run's project (a clone keeps its
 * uncommitted definitions), else the project's registered checkout, as though the line
 * were pasted there.
 */
async function restartCwd(route: WorkflowRoute, failed: WorkflowRun): Promise<string> {
  const { host, effectiveCwd } = route;
  if (!failed.codebase_id) return effectiveCwd;
  const { findLaunchCodebase } = await import('../commands/workflow-isolation');
  const here = await findLaunchCodebase(host, effectiveCwd, {});
  if (here.codebase?.id === failed.codebase_id) return effectiveCwd;
  const project = await host.records.codebases.getCodebase(failed.codebase_id);
  if (!project) throw new Error(`Run ${failed.id} ran in a project that no longer exists.`);
  return project.default_cwd;
}

/**
 * The run `--supersedes` names. A full run id is resolved in its own run's project, so it
 * restarts from any directory; a prefix, in the launch project as the start resolves it.
 */
async function supersededRun(route: WorkflowRoute, codebaseId: string | undefined) {
  const { findLaunchCodebase } = await import('../commands/workflow-isolation');
  const { resolveContinuationDeclaration } = await import('../commands/workflow-run-preflight');
  const { isFullRunId } = await import('@archon/core/workflows/run-id');
  const reference = route.values.supersedes as string;
  const recorded = isFullRunId(reference)
    ? ((await route.host.deps.store.getWorkflowRun(reference))?.codebase_id ?? undefined)
    : undefined;
  const { codebase } = await findLaunchCodebase(route.host, route.effectiveCwd, {
    codebaseId: codebaseId ?? recorded,
  });
  const declaration = await resolveContinuationDeclaration(
    route.host,
    { supersedesRunId: route.values.supersedes as string },
    codebase
  );
  if (!declaration || !('superseded' in declaration)) {
    throw new Error('Expected --supersedes to resolve the run it supersedes.');
  }
  return declaration.superseded;
}

/**
 * `workflow run --supersedes <run-id>` with no workflow name: start the run again as its
 * record describes it, with its workflow, message, inputs, definitions source and lane
 * (see `restartOfRun`). This is the line `workflow resume` prints for a run that failed
 * before its checkout was prepared; it holds only the run id, so it pastes into any shell.
 */
async function runRestart(route: WorkflowRoute): Promise<number> {
  const { host, values, json } = route;
  const conflict = restartFlagConflict(values);
  if (conflict) return await fail(json, conflict);
  const codebaseId = await resolveRunProject(route);
  if (codebaseId === 1) return 1;
  const failed = await supersededRun(route, codebaseId);
  const { restartOfRun } = await import('../commands/workflow-run-restart');
  const restart = restartOfRun(failed);
  if (restart.workflowSource !== undefined) {
    const sourceConflict = workflowSourceConflict(values);
    if (sourceConflict) return await fail(json, sourceConflict);
    if (!(await isPathDirectory(restart.workflowSource))) {
      return await fail(
        json,
        `Error: run ${failed.id} read its workflow from ${restart.workflowSource}, which is no longer a directory.`
      );
    }
  }
  const options: WorkflowRunOptions = buildRunOptions(
    route,
    restart.workflowSource,
    codebaseId,
    undefined
  );
  options.inputs = restart.inputs
    ? Object.entries(restart.inputs).map(([name, value]) => `${name}=${value}`)
    : undefined;
  const { lane } = restart;
  if (lane.kind === 'adopt') {
    options.adoptRunId = lane.runId;
    options.supersedesRunId = undefined;
    // An adoption would take the hand-off run's item; the restart stays on the failed run's.
    if (options.item === undefined && failed.item_id) {
      options.item = (await host.deps.store.getItem(failed.item_id))?.key;
    }
  } else {
    options.supersedesRunId = lane.runId;
    options.fromBranch = lane.copyHandoff?.commit;
    options.checkoutHandoff = lane.copyHandoff;
    // An explicit --base wins; --no-worktree runs in place, where a base has no effect.
    if (!options.noWorktree) options.baseBranch ??= restart.baseBranch;
  }
  await route.commands.workflowRunCommand(
    host,
    codebaseId === undefined ? await restartCwd(route, failed) : route.effectiveCwd,
    restart.workflowName,
    restart.userMessage,
    options
  );
  return 0;
}
