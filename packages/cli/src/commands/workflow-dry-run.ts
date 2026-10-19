import { isAbsolute, join } from 'node:path';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import type { WorkflowDeps } from '@archon/workflows/deps';
import {
  applyResolvedRunModelOverrides,
  buildAiProfile,
  resolveRunModelOverrides,
  type BuildAiProfileOptions,
  type ResolvedAiProfile,
  type RunModelOverrides,
} from '@archon/workflows/model-validation';
import { applyWorkflowRunConfigLayer } from '@archon/workflows/run-config';
import type { WorkflowRunConfigInput } from '@archon/workflows/schemas/run-config';
import type { ResolvedWorkflow } from '@archon/workflows/schemas/workflow';
import { resolveTopLevelInputs } from '@archon/workflows/utils/workflow-requirements';
import { parseInputAssignments } from '@archon/workflows/workflow-inputs';
import {
  dryRunWorkflow,
  formatDryRunTrace,
  loadDryRunStubs,
  writeDryRunStubScaffold,
} from '@archon/workflows/dry-run';
import { resolveCliUserId } from '../utils/cli-user';
import { writeJsonLine, writeStdout } from '../utils/stdout';
import { getLog, type WorkflowRunOptions } from './workflow-shared';

async function resolveCliDryRunAiPrefs(
  host: WorkflowHost
): Promise<Awaited<ReturnType<NonNullable<WorkflowDeps['getUserAiPrefs']>>>> {
  const cliId = resolveCliUserId();
  if (!cliId) return {};
  try {
    const cliUser = await host.records.users.findOrCreateUserByPlatformIdentity(
      'cli',
      cliId,
      cliId
    );
    return cliUser ? ((await host.deps.getUserAiPrefs?.(cliUser.id)) ?? {}) : {};
  } catch (error) {
    getLog().warn({ err: error as Error, cliId }, 'cli.dry_run_user_ai_prefs_resolve_failed');
    return {};
  }
}

function resolveStubPath(cwd: string, path: string | undefined): string | undefined {
  return path ? (isAbsolute(path) ? path : join(cwd, path)) : undefined;
}

/** Flags a dry run refuses, checked before it reads anything. */
function assertDryRunFlags(options: WorkflowRunOptions): void {
  const incompatible = [
    ['--branch', options.branchName !== undefined],
    ['--from/--from-branch', options.fromBranch !== undefined],
    ['--base', options.baseBranch !== undefined],
    ['--no-worktree', options.noWorktree === true],
    ['--folder', options.folder === true],
    ['--container', options.container === true],
    ['--resume', options.resume === true],
    ['--detach', options.detach === true],
  ] as const;
  const incompatibleFlag = incompatible.find(([, present]) => present)?.[0];
  if (incompatibleFlag) {
    throw new Error(`--dry-run cannot be combined with ${incompatibleFlag}.`);
  }
  if (options.stubsInitPath !== undefined && options.stubsPath !== undefined) {
    throw new Error('--stubs-init cannot be combined with --stubs.');
  }
  if (options.stubsInitPath !== undefined && options.defaultStubs) {
    throw new Error('--stubs-init cannot be combined with --default-stubs.');
  }
}

/**
 * The AI profile a real run would build for this install. User preferences that do not
 * build a profile are logged and dropped, leaving the repo and run layers.
 */
async function buildDryRunBaseProfile(
  host: WorkflowHost,
  dryRunFileConfig: Awaited<ReturnType<WorkflowDeps['loadConfig']>>,
  runConfig: WorkflowRunConfigInput | undefined
): Promise<ResolvedAiProfile> {
  const dryRunUserPrefs = await resolveCliDryRunAiPrefs(host);
  let dryRunDefaultProvider =
    runConfig?.layer.assistant ?? dryRunUserPrefs.defaultProvider ?? dryRunFileConfig.assistant;
  let dryRunProfileOptions: BuildAiProfileOptions = {
    repoTiers: dryRunFileConfig.tiers,
    repoAliases: dryRunFileConfig.aliases,
    userTiers: dryRunUserPrefs.tiers,
    userAliases: dryRunUserPrefs.aliases,
    runTiers: runConfig?.layer.tiers,
    runAliases: runConfig?.layer.aliases,
  };
  let dryRunBaseProfile: ResolvedAiProfile;
  try {
    dryRunBaseProfile = buildAiProfile(dryRunDefaultProvider, dryRunProfileOptions);
  } catch (error) {
    getLog().error({ err: error as Error }, 'cli.dry_run_user_ai_prefs_profile_invalid');
    dryRunDefaultProvider = runConfig?.layer.assistant ?? dryRunFileConfig.assistant;
    dryRunProfileOptions = {
      repoTiers: dryRunFileConfig.tiers,
      repoAliases: dryRunFileConfig.aliases,
      runTiers: runConfig?.layer.tiers,
      runAliases: runConfig?.layer.aliases,
    };
    dryRunBaseProfile = buildAiProfile(dryRunDefaultProvider, dryRunProfileOptions);
  }
  return dryRunBaseProfile;
}

/** `workflow run --dry-run`: trace the workflow through the simulator. No run is created. */
export async function runDryRun(
  host: WorkflowHost,
  workflow: ResolvedWorkflow,
  cwd: string,
  userMessage: string,
  options: WorkflowRunOptions,
  runConfig: WorkflowRunConfigInput | undefined,
  modelOverrides: RunModelOverrides | undefined
): Promise<void> {
  assertDryRunFlags(options);

  // The IDENTICAL invocation gate a real run passes through (#2610): parse
  // `--input name=value`, validate against the declared `inputs:` contract, and fail
  // with the same errors (undeclared key, missing required) before any trace output.
  // Only the supplied entries travel; the simulator derives declared defaults itself,
  // mirroring the executor's `defaultRunInputs` merge at run start.
  const dryRunInputs = resolveTopLevelInputs(
    workflow,
    options.inputs ? parseInputAssignments(options.inputs) : undefined
  );

  // Relative stub paths resolve from `--cwd`, as the CLI reference states. They are the
  // operator's dry-run inputs, not part of the workflow's source, so `--workflow-source`
  // must not silently move where they are read from or written to.
  const stubsPath = resolveStubPath(cwd, options.stubsPath);
  const stubsInitPath = resolveStubPath(cwd, options.stubsInitPath);
  if (stubsInitPath !== undefined) {
    const scaffold = await writeDryRunStubScaffold(workflow, stubsInitPath);
    const nodeCount = Object.keys(scaffold).length;
    if (options.json) {
      await writeJsonLine({ workflow: workflow.name, stubsPath: stubsInitPath, nodeCount });
    } else {
      await writeStdout(
        `Created dry-run stub scaffold for ${workflow.name}: ${stubsInitPath} (${String(nodeCount)} nodes)\n`
      );
    }
    return;
  }
  const stubs = await loadDryRunStubs(stubsPath);
  // The install's config + AI profile are what make the per-node provider/model report
  // match a real run — tier keywords and `@alias` refs resolve through the same profile
  // the executor builds.
  //
  // NOT wrapped in a catch: `loadConfig` returns defaults when there is no config file,
  // so a throw means a malformed or unreadable one. Reporting against fabricated
  // defaults would hand the user a clean-looking trace of a run that cannot happen —
  // the same fail-fast reasoning the folder project's container-policy load spells out.
  // The target workspace, never the authoring root: `--exec-code` runs real bash and
  // script nodes, and running them in the checkout the workflow was merely READ from
  // would mutate the author's tree instead of the one they aimed the dry run at.
  const dryRunFileConfig = await host.deps.loadConfig(cwd);
  const dryRunConfig = applyWorkflowRunConfigLayer(dryRunFileConfig, runConfig?.layer);
  const dryRunBaseProfile = await buildDryRunBaseProfile(host, dryRunFileConfig, runConfig);
  const dryRunModelOverrides = resolveRunModelOverrides(
    host.deps.providers,
    dryRunBaseProfile,
    modelOverrides
  );
  const result = await dryRunWorkflow({
    workflow,
    userMessage,
    cwd,
    stubs,
    ...(dryRunInputs ? { inputs: dryRunInputs } : {}),
    execCode: options.execCode,
    defaultStubs: options.defaultStubs,
    pauseAtGates: options.pauseAtGates,
    config: dryRunConfig,
    aiProfile: applyResolvedRunModelOverrides(dryRunBaseProfile, dryRunModelOverrides),
  });
  if (options.json) {
    await writeJsonLine(result);
  } else {
    await writeStdout(`${formatDryRunTrace(result)}\n`);
  }
  if (result.outcome === 'failed') {
    // Same filter `checkFixture` applies: a stub an `all_done` join tolerated
    // never blocked anything, so naming it as a cause of this failure points
    // the reader at the wrong node (#2869).
    const blockingMissingStubs = result.missingStubs.filter(
      nodeId => !result.toleratedMissingStubs.includes(nodeId)
    );
    throw new Error(
      blockingMissingStubs.length > 0
        ? `Dry-run failed; missing stubs: ${blockingMissingStubs.join(', ')}`
        : 'Dry-run failed. See the trace for details.'
    );
  }
}
