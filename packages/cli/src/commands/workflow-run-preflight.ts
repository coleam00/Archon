import type { WorkflowHost } from '@archon/core/workflows/host-store';
import type { Codebase } from '@archon/core/schemas/codebase';
import {
  resolveWorkflowAdoption,
  type AdoptionLane,
} from '@archon/core/operations/workflow-adoption';
import type { WorkflowDeps } from '@archon/workflows/deps';
import {
  isTierName,
  selectModelRef,
  buildAiProfile,
  TIER_NAMES,
  type TierName,
  type RawAliasesConfig,
  type RawTiersConfig,
  type ResolvedAiProfile,
} from '@archon/workflows/model-validation';
import { BUNDLED_VERSION, readTierNoticeState, markTierNoticeShown } from '@archon/paths';
import { assertWorkflowRequirementsMet } from '@archon/workflows/utils/workflow-requirements';
import type { RequirementBearingWorkflow } from '@archon/workflows/utils/workflow-requirements';
import { formatDeprecationNotice } from '@archon/workflows/deprecation';
import type {
  WorkflowDefinition,
  WorkflowSource,
  WorkflowWithSource,
} from '@archon/workflows/schemas/workflow';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { TERMINAL_WORKFLOW_STATUSES } from '@archon/workflows/schemas/workflow-run';
import { resolveCliUserId } from '../utils/cli-user';
import { getLog, resolveRunIdArg, type WorkflowRunOptions } from './workflow-shared';

/** The refusal when `--resume` finds nothing to continue. */
export function buildNoResumableRunError(workflowName: string, cwd: string): Error {
  return new Error(`No resumable run found for workflow '${workflowName}' at path '${cwd}'.`);
}

/** The refusal when the resumable-run lookup itself could not answer. */
export function buildResumeLookupFailureError(error: Error): Error {
  return new Error(
    'Cannot resume: Database lookup failed.\n' +
      `Error: ${error.message}\n` +
      'Hint: Check your database connection before using --resume.'
  );
}

/**
 * Validate a `--supersedes` declaration (#2747): the run must exist and be terminal.
 * Supersede inherits nothing, so existence and terminality are the whole contract.
 *
 * The `--detach` pre-flight, which refuses before forking (#2872), and the run path that
 * records the provenance both reach it through `resolveContinuationDeclaration`.
 */
export async function resolveSupersededRun(
  host: WorkflowHost,
  runId: string
): Promise<WorkflowRun> {
  const superseded = await host.deps.store.getWorkflowRun(runId);
  if (!superseded) {
    throw new Error(`Cannot supersede: no workflow run '${runId}' exists.`);
  }
  if (!TERMINAL_WORKFLOW_STATUSES.includes(superseded.status)) {
    throw new Error(`Cannot supersede run '${superseded.id}': it is still ${superseded.status}.`);
  }
  return superseded;
}

/** A resolved between-run continuation declaration (#2747): `--adopt` or `--supersedes`. */
export type ContinuationDeclaration =
  | { mode: 'adopt'; runId: string; adoptedRun: WorkflowRun; lane: AdoptionLane }
  | { mode: 'supersede'; runId: string; superseded: WorkflowRun };

/**
 * Resolve `--adopt` or `--supersedes` to the run it names, or `undefined` when neither is
 * set. Adoption resolves the lane it dictates; supersede validates the prior run only. Both
 * the `--detach` pre-flight and the run path call this, so a declaration the run path would
 * refuse is refused before the fork too.
 */
export async function resolveContinuationDeclaration(
  host: WorkflowHost,
  cwd: string,
  options: Pick<WorkflowRunOptions, 'adoptRunId' | 'supersedesRunId' | 'container'>,
  codebase: Codebase | null | undefined
): Promise<ContinuationDeclaration | undefined> {
  const declared =
    options.adoptRunId !== undefined
      ? { mode: 'adopt' as const, ref: options.adoptRunId }
      : options.supersedesRunId !== undefined
        ? { mode: 'supersede' as const, ref: options.supersedesRunId }
        : undefined;
  if (!declared) return undefined;
  if (!codebase) {
    throw new Error(
      'Cannot resolve the project for --adopt/--supersedes. Run from the project checkout and try again.'
    );
  }
  const runId = await resolveRunIdArg(host, declared.ref, cwd, false, codebase.id);
  if (declared.mode === 'adopt') {
    const { adoptedRun, lane } = await resolveWorkflowAdoption({
      deps: {
        getRun: id => host.deps.store.getWorkflowRun(id),
        getActiveRunByPath: (...args) => host.deps.store.getActiveWorkflowRunByPath(...args),
        findEnvironmentByPath: (...args) =>
          host.records.isolation.findLatestByCodebaseAndWorkingPath(...args),
      },
      adoptedRunId: runId,
      codebaseId: codebase.id,
      codebasePath: codebase.default_cwd,
      codebaseKind: codebase.kind,
      containerRequested: options.container === true,
    });
    return { mode: 'adopt', runId, adoptedRun, lane };
  }
  return { mode: 'supersede', runId, superseded: await resolveSupersededRun(host, runId) };
}

/**
 * The acting CLI user's Archon id, or undefined when `ARCHON_USER_ID`/`$USER` is unset
 * or the identity cannot be resolved. Attribution is best-effort by design — a run must
 * not fail because the user table could not be reached.
 */
export async function resolveCliUserRecordId(host: WorkflowHost): Promise<string | undefined> {
  const cliId = resolveCliUserId();
  if (!cliId) return undefined;
  try {
    const cliUser = await host.records.users.findOrCreateUserByPlatformIdentity(
      'cli',
      cliId,
      cliId
    );
    return cliUser?.id;
  } catch (error) {
    getLog().warn({ err: error as Error, cliId }, 'cli.user_identity_resolve_failed');
    return undefined;
  }
}

/**
 * Capability gate for the CLI run path.
 *
 * Mirrors the orchestrator's `requires: [github]` enforcement
 * (workflow-dispatch.ts `dispatchOrchestratorWorkflow`) so a workflow that
 * declares `requires: [github]` is hard-blocked BEFORE any worktree/clone/AI
 * cost — and before the `--detach` fork — when the acting CLI user hasn't
 * connected their GitHub identity. Throws WorkflowRequirementError, surfaced by
 * the CLI top-level handler (cli.ts) as a clean, actionable `Error: ...` line.
 *
 * No-op on solo PAT installs: `host.deps.isPerUserGitHubEnabled?.()` is false unless the
 * GitHub App + TOKEN_ENCRYPTION_KEY are both configured — identical semantics
 * to the orchestrator gate.
 */
export async function assertCliWorkflowRequirementsMet(
  host: WorkflowHost,
  workflow: RequirementBearingWorkflow
): Promise<void> {
  if (!host.deps.isPerUserGitHubEnabled?.() || !workflow.requires?.length) return;

  // Resolve the acting CLI user (ARCHON_USER_ID, else $USER/$USERNAME) → Archon
  // user id, then check for a stored GitHub connection. An unresolvable user or
  // a lookup failure means "not connected" — fail closed, never silently allow.
  const cliId = resolveCliUserId();
  let githubConnected = false;
  if (cliId) {
    try {
      const cliUser = await host.records.users.findOrCreateUserByPlatformIdentity(
        'cli',
        cliId,
        cliId
      );
      githubConnected =
        cliUser !== null && Boolean(await host.deps.getUserGithubToken?.(cliUser.id));
    } catch (error) {
      getLog().warn({ err: error as Error, cliId }, 'cli.requirement_gate_user_resolve_failed');
    }
  }

  assertWorkflowRequirementsMet(workflow, { githubConnected });
}

/**
 * Print a one-time per-version tier notice to stderr when the workflow uses
 * unconfigured tier-keyword nodes (small/medium/large resolving via built-in
 * defaults). Suppressed under --quiet. Uses the same 7-char tier column as
 * `archon ai tier list`.
 */
export async function maybePrintTierNotice(
  host: WorkflowHost,
  workflow: Pick<WorkflowDefinition, 'model'> & {
    readonly nodes: readonly WorkflowDefinition['nodes'][number][];
  },
  cwd: string,
  cliUserId: string | undefined,
  quiet: boolean | undefined
): Promise<void> {
  if (quiet) return;

  // Collect tier keywords used by the workflow-level default and per-node overrides.
  // A preference list counts by the ref it selects: first with no aliases, to skip the
  // config load when no node can land on a tier, then against the configured aliases.
  const refs = [
    workflow.model,
    ...workflow.nodes.map(node => ('model' in node ? node.model : undefined)),
  ];
  const tiersSelected = (aliases?: ResolvedAiProfile['aliases']): Set<TierName> => {
    const tiers = new Set<TierName>();
    for (const ref of refs) {
      const selected = selectModelRef(ref, aliases ? { aliases } : undefined);
      if (selected !== undefined && isTierName(selected)) tiers.add(selected);
    }
    return tiers;
  };
  if (tiersSelected().size === 0) return;

  // Load install config to see which tiers are explicitly configured.
  let config: Awaited<ReturnType<WorkflowDeps['loadConfig']>>;
  try {
    config = await host.deps.loadConfig(cwd);
  } catch (err) {
    getLog().debug({ err }, 'tier_notice.config_load_failed');
    return;
  }
  const configuredTiers: RawTiersConfig = config.tiers ?? {};

  // Layer in the CLI user's personal tier prefs (best-effort, non-fatal).
  let userTiers: RawTiersConfig = {};
  let userAliases: RawAliasesConfig = {};
  let userDefaultProvider: string | undefined;
  if (cliUserId) {
    try {
      const prefs = (await host.deps.getUserAiPrefs?.(cliUserId)) ?? {};
      userTiers = prefs.tiers ?? {};
      userAliases = prefs.aliases ?? {};
      userDefaultProvider = prefs.defaultProvider;
    } catch {
      // Non-fatal — proceed without user tier info.
    }
  }

  // A list whose alias is configured runs on that alias, not on a tier.
  const usedTiers = tiersSelected({ ...config.aliases, ...userAliases });

  // Only notify when at least one used tier is unconfigured (built-in default).
  const hasUnconfigured = [...usedTiers].some(t => !configuredTiers[t] && !userTiers[t]);
  if (!hasUnconfigured) return;

  // One-time per Archon version (a version bump may ship new tier defaults).
  const version = BUNDLED_VERSION;
  if (readTierNoticeState()?.shownForVersion === version) return;

  // Build the resolved profile for the effective default assistant.
  const effectiveAssistant = userDefaultProvider ?? config.assistant;
  let aliases: ReturnType<typeof buildAiProfile>['aliases'];
  try {
    aliases = buildAiProfile(effectiveAssistant, {
      globalTiers: configuredTiers,
      userTiers,
    }).aliases;
  } catch (err) {
    // Non-fatal: a corrupt tier/alias config can make buildAiProfile throw —
    // skip the notice rather than blocking the run.
    getLog().debug({ err }, 'tier_notice.build_profile_failed');
    return;
  }

  const notice = formatTierNotice(effectiveAssistant, aliases);
  if (notice === undefined) return;
  process.stderr.write(notice);

  markTierNoticeShown(version);
}

function formatTierNotice(
  effectiveAssistant: string | undefined,
  aliases: ResolvedAiProfile['aliases']
): string | undefined {
  const tierLines: string[] = [];
  for (const t of TIER_NAMES) {
    const preset = aliases[t];
    if (preset) tierLines.push(`     ${t.padEnd(7)} → ${preset.provider}/${preset.model}`);
  }
  // Only claude and codex ship built-in tier defaults. With none for this
  // provider there is nothing truthful to announce — the run's tier
  // resolution fails loudly with the full configuration guidance, and this
  // notice must not claim defaults are in play. Not marked shown: once the
  // operator configures tiers for a provider WITH built-ins, the one-time
  // notice should still fire.
  if (tierLines.length === 0) return;
  const lines: string[] = [
    "ℹ️  This workflow uses model tiers (small/medium/large). You haven't configured them —",
    `   using built-in defaults for '${effectiveAssistant}':`,
    ...tierLines,
  ];
  // Plan-dependent 1M note for the large→opus row (the CLI can't detect the plan).
  const largePreset = aliases.large;
  if (largePreset?.provider === 'claude' && largePreset.model === 'opus') {
    lines.push(
      '   (Opus runs a 1M context window on API keys and Max/Team/Enterprise;',
      "    on Pro it's 200K unless you set the `large` tier to `opus[1m]`.)"
    );
  }
  lines.push(
    '   Customize: `archon ai tier set <tier> <provider> <model>`',
    '              or `tiers:` in .archon/config.yaml',
    '   See anytime: `archon ai tier list`           (shown once per version)',
    ''
  );
  return lines.join('\n') + '\n';
}

/**
 * Print a workflow's parse warnings (keys the engine silently drops) to stderr.
 *
 * stderr rather than stdout so `--json` callers keep a parseable payload while
 * still being told; `console.warn` rather than the logger because `--json` sets
 * the log level to silent, which is exactly the case this has to survive.
 */
export function emitParseWarnings(
  parseWarnings: readonly string[] | undefined,
  workflowName: string
): void {
  if (!parseWarnings || parseWarnings.length === 0) return;
  console.warn(`Warning: '${workflowName}' declares keys the engine ignores:`);
  for (const warning of parseWarnings) {
    console.warn(`  - ${warning}`);
  }
}

/**
 * Print a deprecated workflow's removal notice (#2781) to stderr.
 *
 * Same channel as emitParseWarnings: stderr keeps `--json` stdout parseable,
 * and `console.warn` survives `--json`'s log silencing. Not gated on --quiet —
 * a user driving runs programmatically still has to learn the default they
 * picked is scheduled for removal.
 */
export function emitDeprecationNotice(
  workflow: Pick<WorkflowDefinition, 'name' | 'deprecated'>
): void {
  const notice = formatDeprecationNotice(workflow);
  if (notice) console.warn(notice);
}

export function countWorkflowSources(
  workflows: readonly WorkflowWithSource[]
): Record<WorkflowSource, number> {
  return workflows.reduce<Record<WorkflowSource, number>>(
    (counts, entry) => {
      counts[entry.source] += 1;
      return counts;
    },
    { bundled: 0, global: 0, project: 0, installed: 0 }
  );
}

/**
 * Refusals that depend only on how the run was invoked, checked before the dry-run
 * branch so a dry run reports them too.
 */
export function assertInvocationFlags(options: WorkflowRunOptions, isContinuation: boolean): void {
  if (isContinuation && options.modelAssignments && options.modelAssignments.length > 0) {
    throw new Error(
      '--resume and --model are mutually exclusive. A resumed run keeps its original model bindings.'
    );
  }

  if (options.registrationBaseBranch !== undefined) {
    if (!options.registrationBaseBranch.trim())
      throw new Error('--base-branch requires a nonempty branch name.');
    if (
      options.resume ||
      options.adoptRunId !== undefined ||
      options.supersedesRunId !== undefined ||
      options.dryRun
    )
      throw new Error(
        '--base-branch applies only to initial registration and cannot be combined with --resume, --adopt, --supersedes, or --dry-run.'
      );
  }

  const dryRunOnlyOptions = [
    ['--stubs', options.stubsPath !== undefined],
    ['--stubs-init', options.stubsInitPath !== undefined],
    ['--default-stubs', options.defaultStubs === true],
    ['--exec-code', options.execCode === true],
    ['--pause-at-gates', options.pauseAtGates === true],
  ] as const;
  const optionWithoutDryRun = dryRunOnlyOptions.find(([, present]) => present)?.[0];
  if (!options.dryRun && optionWithoutDryRun) {
    throw new Error(`${optionWithoutDryRun} requires --dry-run.`);
  }
}

/**
 * Flag combinations a real run refuses. Defensive — cli.ts checks these for UX, but
 * workflowRunCommand is the authoritative boundary for programmatic callers.
 */
export function assertExecutionFlags(options: WorkflowRunOptions): void {
  if (options.branchName !== undefined && options.noWorktree) {
    throw new Error(
      '--branch and --no-worktree are mutually exclusive.\n' +
        '  --branch creates an isolated worktree (safe).\n' +
        '  --no-worktree runs directly in your repo (no isolation).\n' +
        'Use one or the other.'
    );
  }
  if (options.noWorktree && options.fromBranch !== undefined) {
    throw new Error(
      '--from/--from-branch has no effect with --no-worktree.\n' +
        'Remove --from or drop --no-worktree.'
    );
  }
  if (options.noWorktree && options.baseBranch !== undefined) {
    throw new Error(
      '--base has no effect with --no-worktree.\n' + 'Remove --base or drop --no-worktree.'
    );
  }
  if (options.resume && options.branchName !== undefined) {
    throw new Error(
      '--resume and --branch are mutually exclusive.\n' +
        '  --resume reuses the existing worktree from the failed run.\n' +
        '  Remove --branch when using --resume.'
    );
  }
  if (options.resume && options.inputs !== undefined && options.inputs.length > 0) {
    throw new Error(
      '--resume and --input are mutually exclusive.\n' +
        "  A resume replays the original invocation's inputs, recorded on the run.\n" +
        '  Drop --input to resume, or start a fresh run to supply different values.'
    );
  }

  assertContinuationFlags(options);
}

/**
 * Between-run continuation (#2747): adoption dictates the lane itself, so the
 * lane-choosing flags are refused rather than silently overridden.
 */
function assertContinuationFlags(options: WorkflowRunOptions): void {
  if (options.adoptRunId !== undefined) {
    const conflicts: string[] = [];
    if (options.resume) conflicts.push('--resume');
    if (options.branchName !== undefined) conflicts.push('--branch');
    if (options.fromBranch !== undefined) conflicts.push('--from/--from-branch');
    if (options.baseBranch !== undefined) conflicts.push('--base');
    if (options.noWorktree) conflicts.push('--no-worktree');
    if (conflicts.length > 0) {
      throw new Error(
        `--adopt and ${conflicts.join('/')} are mutually exclusive.\n` +
          '  Adoption resolves its own lane: reuse the adopted worktree, or cut a fresh one from its branch.'
      );
    }
  } else if (options.supersedesRunId !== undefined && options.resume) {
    throw new Error(
      '--supersedes records a FRESH-lane rerun as replacing a prior open item; it cannot be combined with --resume.'
    );
  }
}

/**
 * Reconcile the workflow YAML's `worktree.enabled` pin with the invocation flags. A
 * mismatch is a user error surfaced loudly rather than silently applying one side.
 */
export function assertWorktreePolicy(
  workflow: Pick<WorkflowDefinition, 'name' | 'worktree'>,
  options: WorkflowRunOptions
): void {
  const pinnedEnabled = workflow.worktree?.enabled;
  if (pinnedEnabled === false) {
    if (options.branchName !== undefined) {
      throw new Error(
        `Workflow '${workflow.name}' sets worktree.enabled: false (runs in live checkout).\n` +
          '  --branch requires an isolated worktree.\n' +
          "  Drop --branch or change the workflow's worktree.enabled."
      );
    }
    if (options.fromBranch !== undefined) {
      throw new Error(
        `Workflow '${workflow.name}' sets worktree.enabled: false (runs in live checkout).\n` +
          '  --from/--from-branch only applies when a worktree is created.\n' +
          "  Drop --from or change the workflow's worktree.enabled."
      );
    }
    if (options.baseBranch !== undefined) {
      throw new Error(
        `Workflow '${workflow.name}' sets worktree.enabled: false (runs in live checkout).\n` +
          '  --base only applies when a worktree is created.\n' +
          "  Drop --base or change the workflow's worktree.enabled."
      );
    }
    // --no-worktree is redundant but not contradictory — silently accept.
  } else if (pinnedEnabled === true) {
    if (options.noWorktree) {
      throw new Error(
        `Workflow '${workflow.name}' sets worktree.enabled: true (requires a worktree).\n` +
          '  --no-worktree conflicts with the workflow policy.\n' +
          "  Drop --no-worktree or change the workflow's worktree.enabled."
      );
    }
  }
}
