import { formatDeprecationNotice } from '@archon/workflows/deprecation';
import type { ResolvedWorkflow } from '@archon/workflows/schemas/workflow';
import {
  assertWorkflowRequirementsMet,
  resolveTopLevelInputs,
  WorkflowMissingInputsError,
  WorkflowRequirementError,
} from '@archon/workflows/utils/workflow-requirements';
import { WorkflowInputContractError } from '@archon/workflows/workflow-inputs';
import { getDecryptedAccessToken } from '../../db/user-github-token-store';
import { isPerUserGitHubEnabled } from '../../github-auth/config';
import { toError } from '../../utils/error';
import { getLog } from '../agent-log';
import type { DispatchScope } from './scope';

export type SignatureGates =
  | { ok: false }
  | { ok: true; resolvedInputs?: Record<string, string>; deferredInputError?: Error };

/**
 * Input signature gate (#2470, #2554) plus capability gate, judged against ONE
 * workflow definition. A checkout-branch adoption swaps the definition for the
 * branch's vintage only after isolation resolves its worktree, so these gates must
 * run AFTER that swap there — otherwise required inputs or `requires:` declared on
 * the branch would bypass them entirely.
 */
export async function runSignatureGates(
  scope: DispatchScope,
  definition: ResolvedWorkflow,
  willContinueExistingRun: boolean
): Promise<SignatureGates> {
  const inputs = await resolveInvocationInputs(scope, definition, willContinueExistingRun);
  if (!inputs.ok) return inputs;
  if (!(await githubRequirementMet(scope, definition))) return { ok: false };
  return inputs;
}

/**
 * Resolve this invocation's declared inputs from the values its channel supplied —
 * the run route's `inputs` map or the chat agent's `invoke_workflow` launch. A channel
 * that supplies nothing still refuses a required-input workflow here. The workflow still
 * lists/loads normally.
 */
async function resolveInvocationInputs(
  scope: DispatchScope,
  definition: ResolvedWorkflow,
  willContinueExistingRun: boolean
): Promise<SignatureGates> {
  const { platform, conversationId, options } = scope;
  try {
    return { ok: true, resolvedInputs: resolveTopLevelInputs(definition, options?.inputs) };
  } catch (err) {
    // Both are user-facing contract violations: a missing required input, and — now
    // that a caller can supply values — a key the workflow does not declare.
    if (!(err instanceof WorkflowMissingInputsError || err instanceof WorkflowInputContractError))
      throw err;
    getLog().info(
      {
        workflowName: definition.name,
        // Names only, never values — a supplied value is user content (logging rules).
        missing: err instanceof WorkflowMissingInputsError ? err.missing : undefined,
        suppliedKeys: options?.inputs ? Object.keys(options.inputs) : [],
        deferred: willContinueExistingRun,
      },
      'workflow.required_inputs_unsatisfiable'
    );
    if (!willContinueExistingRun) {
      await platform.sendMessage(conversationId, err.message);
      return { ok: false };
    }
    // A contract violation held back because a resume may make it moot. Only the one
    // branch in `continueForegroundResume` that falls through to a FRESH run row
    // (hydration found nothing worth resuming) still needs it; every other
    // continuation path never reads inputs from this invocation at all.
    return { ok: true, deferredInputError: err };
  }
}

/**
 * Capability gate: hard-fail before any worktree/clone/AI cost if the
 * workflow declares `requires: [github]` and the originating user hasn't
 * connected. No-op when per-user GitHub is disabled (solo PAT installs).
 */
async function githubRequirementMet(
  scope: DispatchScope,
  definition: ResolvedWorkflow
): Promise<boolean> {
  const { platform, conversationId, userId } = scope;
  if (!isPerUserGitHubEnabled() || !definition.requires?.length) return true;
  const githubConnected = userId ? Boolean(await getDecryptedAccessToken(userId)) : false;
  try {
    assertWorkflowRequirementsMet(definition, { githubConnected });
  } catch (err) {
    if (!(err instanceof WorkflowRequirementError)) throw err;
    getLog().info(
      { workflowName: definition.name, conversationId, userId, requirement: err.requirement },
      'workflow.requirement_unmet'
    );
    await platform.sendMessage(conversationId, err.message);
    return false;
  }
  return true;
}

export async function sendRunStartNotices(
  scope: DispatchScope,
  workflow: ResolvedWorkflow
): Promise<void> {
  const { platform, conversationId, parseWarnings } = scope;
  // Keys the engine dropped from this workflow's YAML (#2213). Every chat and
  // console run funnels through here, so this is the one place that covers all
  // of them. Sent before the run starts and independently of the run's own
  // output, so it lands even when the workflow immediately backgrounds itself.
  // Best-effort: a delivery failure must not stop the run the user asked for.
  if (parseWarnings && parseWarnings.length > 0) {
    const lines = parseWarnings.map(w => `- ${w}`).join('\n');
    try {
      await platform.sendMessage(
        conversationId,
        `⚠️ \`${workflow.name}\` declares keys the engine ignores:\n${lines}`
      );
    } catch (error) {
      getLog().warn(
        { err: toError(error), conversationId, workflowName: workflow.name },
        'workflow.parse_warning_delivery_failed'
      );
    }
  }

  // Deprecated bundled default (#2781). Same reach as the parse warnings above:
  // every chat and console run funnels through here, before any background split,
  // so the removal notice lands on each surface the run reports to. Derived from
  // the definition itself — a copied override in project/global `.archon`
  // (same filename) drops the marker and the notice with it. Best-effort.
  const deprecationNotice = formatDeprecationNotice(workflow);
  if (deprecationNotice) {
    try {
      await platform.sendMessage(conversationId, deprecationNotice);
    } catch (error) {
      getLog().warn(
        { err: toError(error), conversationId, workflowName: workflow.name },
        'workflow.deprecation_notice_delivery_failed'
      );
    }
  }
}
