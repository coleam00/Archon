import type { WorkflowHost } from '@archon/core/workflows/host-store';
import type { WorkflowDeps } from '@archon/workflows/deps';
import {
  isTierName,
  buildAiProfile,
  TIER_NAMES,
  type TierName,
  type RawTiersConfig,
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
import { getLog } from './workflow-shared';

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
 * One owner for the refusals because two callers need them: the `--detach` pre-flight,
 * which refuses before forking (#2872), and the run path that records the provenance.
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

  // Collect tier keywords used by the workflow — check the workflow-level default
  // first (model: large at the top level applies to all nodes without overrides),
  // then per-node overrides.
  const usedTiers = new Set<TierName>();
  if (typeof workflow.model === 'string' && isTierName(workflow.model)) {
    usedTiers.add(workflow.model);
  }
  for (const node of workflow.nodes) {
    if ('model' in node && typeof node.model === 'string' && isTierName(node.model)) {
      usedTiers.add(node.model);
    }
  }
  if (usedTiers.size === 0) return;

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
  let userDefaultProvider: string | undefined;
  if (cliUserId) {
    try {
      const prefs = (await host.deps.getUserAiPrefs?.(cliUserId)) ?? {};
      userTiers = prefs.tiers ?? {};
      userDefaultProvider = prefs.defaultProvider;
    } catch {
      // Non-fatal — proceed without user tier info.
    }
  }

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
  process.stderr.write(lines.join('\n') + '\n');

  markTierNoticeShown(version);
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
