import type { AgentNode } from '../../../schemas';
import { readComposedBindings, resolveIncludeOutputAliases } from '../../../compiled-command';
import { buildPromptWithContext } from '../../../workflow-variables';
import { getLog } from '../../log';
import type { loadNodeCommandPrompt } from '../../node-source';
import type { RunLayersContext } from '../../run-context';
import { resolveRunInputs, resolveNodeBindings, nodeTemplateReferences } from '../../references';

type CommandPrompt = Awaited<ReturnType<typeof loadNodeCommandPrompt>>;

/**
 * The node's resolved prompt, or why it could not be built. Either failure happens before the
 * provider is called; `notify` says whether the user is told directly.
 */
export type AgentPrompt =
  | { ok: true; prompt: string }
  | { ok: false; error: string; notify: boolean };

/**
 * Builds the prompt the provider receives from the inline prompt or the command file loaded
 * before binding. `commandPrompt` is set exactly when the node is command-sourced.
 */
export function loadAgentPrompt(
  ctx: RunLayersContext,
  node: AgentNode,
  stepName: string,
  commandPrompt: CommandPrompt | undefined,
  extras: {
    typedArtifactsFile: string | undefined;
    /** `$REJECTION_REASON` for an approval gate's rework prompt; undefined elsewhere. */
    rejectionReason: string | undefined;
  }
): AgentPrompt {
  let rawPrompt: string;
  if (node.source.kind === 'command') {
    if (commandPrompt === undefined) throw new Error(`Missing prepared command for '${stepName}'`);
    if (!commandPrompt.success) {
      const errMsg = commandPrompt.message;
      getLog().error({ nodeId: node.id, error: errMsg }, 'dag_node_command_load_failed');
      return { ok: false, error: errMsg, notify: false };
    }
    rawPrompt = resolveIncludeOutputAliases(node, commandPrompt.content);
  } else {
    rawPrompt = node.source.prompt;
  }

  // Include expansion compiles a command body into an inline prompt and moves the node's
  // `with:` map to the engine-private payload, so a composed node binds exactly as the
  // same node does standalone (#2964).
  const nodeWith = node.source.kind === 'command' ? node.source.with : readComposedBindings(node);
  const { workflowRun } = ctx;
  try {
    // Node-local bindings (#2637): a command node's `with:` map resolves against
    // upstream outputs and merges OVER the run's inputs into the `$INPUTS` bag —
    // nearest-wins, the same precedence the shell env channel documents. A binding
    // that cannot be satisfied throws here and fails the node via the catch below.
    const runInputs = resolveRunInputs(workflowRun);
    const nodeBindings =
      nodeWith !== undefined ? resolveNodeBindings(node.id, nodeWith, ctx, runInputs) : undefined;
    const promptInputs =
      nodeBindings !== undefined ? { ...(runInputs ?? {}), ...nodeBindings } : runInputs;
    // An inline prompt and a command file loaded only now resolve alike: variables,
    // enclosing loop_group scopes and upstream outputs in one pass.
    const prompt = buildPromptWithContext(
      rawPrompt,
      workflowRun.id,
      workflowRun.user_message,
      ctx.artifactsDir,
      ctx.baseBranch,
      ctx.docsDir,
      ctx.issueContext,
      `dag node '${node.id}' prompt`,
      {
        stateDir: ctx.stateDir,
        inputs: promptInputs,
        typedArtifactsFile: extras.typedArtifactsFile,
        rejectionReason: extras.rejectionReason,
        references: nodeTemplateReferences(rawPrompt, ctx),
      }
    );
    return { ok: true, prompt };
  } catch (error) {
    const err = error as Error;
    getLog().error({ nodeId: node.id, error: err.message }, 'dag.node_prompt_substitution_failed');
    return { ok: false, error: err.message, notify: true };
  }
}
