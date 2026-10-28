import { resolve } from 'path';
import { stat } from 'fs/promises';
import { rejectConfigOnContinue, RUN_PROJECT_CONFLICT_FLAGS } from '../dispatch-guards';
import { DETACHED_RUN_OWNER_ENV, DETACHED_LAUNCH_TOKEN_ENV } from '../utils/detached-run-control';
import { fail } from './context';
import type { WorkflowRoute } from './workflow';

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
  if (values.resume && branchName !== undefined) {
    return (
      'Error: --resume and --branch are mutually exclusive.\n' +
      '  --resume reuses the existing worktree from the failed run.\n' +
      '  Remove --branch when using --resume.'
    );
  }
  return undefined;
}

// `--workflow-source` picks the authoring directory. It is fresh-run only:
// a resume executes the source its run already captured, so accepting a
// different one here would promise a swap that cannot happen.
function workflowSourceConflict(values: Record<string, unknown>): string | undefined {
  if (values.resume) {
    return (
      'Error: --workflow-source and --resume are mutually exclusive.\n' +
      '  A resumed run executes the source it captured when it started.\n' +
      '  Drop --workflow-source, or start a fresh run to pick up new source.'
    );
  }
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
    const claims = await host.records.codebases.listCodebaseClaims();
    const byId = claims.find(row => row.id === project);
    const matches = byId ? [byId] : claims.filter(row => row.name === project);
    if (matches.length > 1) {
      throw new Error(
        `Project name '${project}' matches ${matches.length} codebases (${matches.map(row => row.id).join(', ')}). Name one by id.`
      );
    }
    const [selected] = matches;
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

function buildRunOptions(
  { values, cwd, json, detachedRunConfig }: WorkflowRoute,
  workflowSource: string | undefined,
  codebaseId: string | undefined
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
    // `--workflow-source` selects WHERE the workflow is read from; `--cwd`
    // continues to select what it acts on. Reusing `discoveryCwd` keeps one
    // internal concept: the directory discovery searches, which the run then
    // freezes as its source.
    discoveryCwd: workflowSource,
    noWorktree: values['no-worktree'] as boolean | undefined,
    folder: values.folder as boolean | undefined,
    container: values.container as boolean | undefined,
    resume: values.resume as boolean | undefined,
    quiet: values.quiet as boolean | undefined,
    verbose: values.verbose as boolean | undefined,
    // Stable scope for persist_session across separate CLI invocations. Without
    // it each run gets a fresh conversation UUID, so persisted sessions never
    // resume between runs (they only resume within chat/REST, which reuse a
    // conversation). Pass the same id on each run to opt into cross-run resume.
    conversationId: values['conversation-id'] as string | undefined,
    detach: values.detach as boolean | undefined,
    json,
    dryRun: values['dry-run'] as boolean | undefined,
    stubsPath: values.stubs as string | undefined,
    stubsInitPath: values['stubs-init'] as string | undefined,
    defaultStubs: values['default-stubs'] as boolean | undefined,
    execCode: values['exec-code'] as boolean | undefined,
    pauseAtGates: values['pause-at-gates'] as boolean | undefined,
    // Raw `name=value` assignments; parsed at the invocation gate (#2554).
    inputs: values.input as string[] | undefined,
    modelAssignments: values.model as string[] | undefined,
    configPath: typeof values.config === 'string' ? resolve(cwd, values.config) : undefined,
    configFromRun: values['config-from-run'] as string | undefined,
    detachedRunConfig,
    detachedRunId: values['internal-detached-run-id'] as string | undefined,
  };
}

export async function runWorkflowRun(route: WorkflowRoute): Promise<number> {
  const { positionals, values, json } = route;
  const workflowName = positionals[2];
  if (!workflowName) {
    return await fail(json, 'Usage: archon workflow run <name> [message]');
  }
  const userMessage = positionals.slice(3).join(' ') || '';
  const configOnContinue = rejectConfigOnContinue(
    values.resume as boolean | undefined,
    values.config,
    values['config-from-run']
  );
  if (configOnContinue) return await fail(json, configOnContinue);
  const worktreeConflict = worktreeFlagConflict(values);
  if (worktreeConflict) return await fail(json, worktreeConflict);
  const codebaseId = await resolveRunProject(route);
  if (codebaseId === 1) return 1;
  const workflowSource = await resolveWorkflowSource(route);
  if (workflowSource === 1) return 1;
  await route.commands.workflowRunCommand(
    route.host,
    route.effectiveCwd,
    workflowName,
    userMessage,
    buildRunOptions(route, workflowSource, codebaseId)
  );
  return 0;
}
