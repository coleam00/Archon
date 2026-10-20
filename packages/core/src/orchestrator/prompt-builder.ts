/**
 * Orchestrator prompt builder
 * Constructs the system prompt for the orchestrator agent with all
 * registered projects and available workflows.
 */
import { INVOKE_WORKFLOW_SCHEMA, REGISTER_PROJECT_SCHEMA } from './chat-tools';
import { resolveProjectAssistant } from '../config/project-assistant';
import type { Codebase, Conversation } from '../types';
import type { WorkflowDefinition } from '@archon/workflows/schemas/workflow';
import {
  isApprovalContext,
  isContainerRun,
  runAttention,
} from '@archon/workflows/schemas/workflow-run';
import {
  attentionAnswerLines,
  spellWorkflowCommand,
  type WorkflowCommandSurface,
} from '@archon/workflows/deps';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { getArchonWorkspacesPath } from '@archon/paths';
import { isRejectableUnreadableGate } from '../operations/workflow-operations';

type PromptWorkflow = Pick<WorkflowDefinition, 'name' | 'description' | 'deprecated' | 'inputs'> & {
  readonly nodes: readonly unknown[];
};

/**
 * Format a single project for the orchestrator prompt.
 *
 * Only the scoped project passes a resolved assistant. Resolving an unpinned
 * project loads its repo config, and an unrelated project's invalid config
 * must not fail every chat turn, so other projects show only a stored pin.
 */
export function formatProjectSection(
  codebase: Codebase,
  assistant: string | null | undefined = codebase.ai_assistant_type
): string {
  let section = `### ${codebase.name}\n`;
  if (codebase.repository_url) {
    section += `- Repository: ${codebase.repository_url}\n`;
  }
  section += `- Directory: ${codebase.default_cwd}\n`;
  if (assistant) section += `- AI Provider: ${assistant}\n`;
  return section;
}

function formatInputs(inputs: PromptWorkflow['inputs']): string {
  const entries = Object.entries(inputs ?? {});
  if (entries.length === 0) return '';
  const lines = entries.map(([name, spec]) => {
    const kind =
      spec.required === true
        ? 'required'
        : spec.default !== undefined
          ? `default: ${JSON.stringify(spec.default)}`
          : 'optional';
    return `    - ${name} (${kind})${spec.description ? `: ${spec.description}` : ''}\n`;
  });
  return `  Inputs:\n${lines.join('')}`;
}

/**
 * Format workflow list for the orchestrator prompt.
 */
export function formatWorkflowSection(workflows: readonly PromptWorkflow[]): string {
  if (workflows.length === 0) {
    return 'No workflows available. Users can create workflows in `.archon/workflows/` as YAML files.\n';
  }

  return workflows
    .map(w => {
      const deprecation = w.deprecated ? `  Deprecated: ${w.deprecated.message}\n` : '';
      return `**${w.name}**\n  ${w.description}\n${deprecation}${formatInputs(w.inputs)}  Type: DAG (${String(w.nodes.length)} nodes)\n\n`;
    })
    .join('');
}

/** WorkflowResult type for prompt context injection */
export interface WorkflowResultContext {
  workflowName: string;
  runId: string;
  summary: string;
}

/**
 * Format recent workflow results for injection into the orchestrator prompt.
 * Returns empty string when there are no results; buildFullPrompt checks for
 * a non-empty string before including the section in the prompt.
 */
export function formatWorkflowContextSection(results: readonly WorkflowResultContext[]): string {
  if (results.length === 0) return '';

  let section = '## Recent Workflow Results\n\n';
  section +=
    'The following workflows recently ran in this conversation. ' +
    'Use this context to answer follow-up questions.\n\n';

  for (const r of results) {
    section += `**${r.workflowName}** (run: ${r.runId})\n`;
    section += r.summary + '\n\n';
  }

  return section.trimEnd();
}

/** The paused run a conversation's approval gate belongs to. */
export interface PausedGateContext {
  /**
   * The paused run itself. The whole row, not a pre-chewed gate: `runAttention`
   * decides what the run needs from outside, and a hand-copied subset would be a
   * second place that decision could be made differently.
   */
  run: Pick<WorkflowRun, 'id' | 'workflow_name' | 'status' | 'metadata'>;
  /**
   * This turn actually has a route to the approve/reject verbs — i.e. the
   * conversation is project-scoped, which is what gates both the `manage_run`
   * tool and the CLI-pointer section. Default `true`. When false the section
   * must not tell the agent to resolve the gate itself; the routes it would name
   * are not wired, and handing out instructions for an absent tool is the same
   * dishonesty this issue removed.
   */
  agentCanResolve?: boolean;
  /**
   * The surface the user reads the agent's answer on. Spells the explicit commands the
   * agent may tell the user to type. Omitted means the chat grammar, `/workflow <command>`.
   */
  surface?: WorkflowCommandSurface;
}

/**
 * Format the "there is a human gate waiting in this conversation" section.
 *
 * This is the ONLY thing that tells the chat agent a gate is open. It states the
 * facts of the gate and the decision policy; it does NOT name a tool, because the
 * verbs reach different providers by different routes (the `manage_run` native
 * tool on Claude/Codex/Pi, the `archon workflow approve|reject` CLI section on the
 * others). Both routes are described elsewhere in the same prompt.
 *
 * Returns '' when there is nothing for the agent to decide — an already-resolved
 * gate is awaiting resume, not a human.
 */
export function formatPausedGateSection(gate: PausedGateContext): string {
  const header = '## Paused Approval Gate\n\n';
  const runId = gate.run.id;
  const workflowName = gate.run.workflow_name;
  const attention = runAttention(gate.run);
  const cmd = (command: string): string => spellWorkflowCommand(gate.surface ?? {}, command);

  // Nothing needs a person: a resolved gate awaiting resume, a durable `wait:`, or a
  // run that already finished. Offering any of those to the agent invites a second
  // decision the operations reject.
  if (
    attention === null ||
    attention.kind === 'terminal' ||
    attention.kind === 'stalled_tool_calls'
  )
    return '';

  if (attention.kind === 'unreadable' && attention.reason === 'source_release_not_continued') {
    return (
      header +
      `Run \`${runId}\` (**${workflowName}**) has no gate: it is ${attention.detail}. ` +
      `Tell the user to resume it with \`${cmd(`resume ${runId}`)}\` once a host can read ` +
      `its source, or to abandon it with \`${cmd(`abandon ${runId}`)}\`.`
    );
  }

  if (attention.kind === 'unreadable') {
    return (
      header +
      `Run \`${runId}\` (**${workflowName}**) is paused, but its approval context is ` +
      'missing or malformed, so the gate cannot be described. Do not resolve it. ' +
      `Tell the user to inspect it with \`${cmd(`get ${runId}`)}\` before choosing an action` +
      (isRejectableUnreadableGate(gate.run, attention)
        ? `; if it should not continue, they can reject it with \`${cmd(`reject ${runId} <reason>`)}\`.`
        : '.')
    );
  }

  if (attention.kind === 'blocked_on_child') {
    return (
      header +
      `Run \`${runId}\` (**${workflowName}**) is paused waiting on its sub-run ` +
      `\`${attention.childRunId}\`, which has a gate of its own. This run has no gate you can resolve — ` +
      'the decision belongs to the child run, and this one continues on its own once the child ' +
      'finishes.'
    );
  }

  if (attention.kind === 'blocked_on_children') {
    return (
      header +
      `Run \`${runId}\` (**${workflowName}**) is paused waiting on its fan-out sub-runs ` +
      `${attention.childRunIds.map(id => `\`${id}\``).join(', ')}. This run has no gate you can ` +
      'resolve — each sub-run that is waiting is answered by its own run id, and this one ' +
      'continues on its own once they finish.'
    );
  }

  if (attention.kind === 'usage_limit') {
    return (
      header +
      `Run \`${runId}\` (**${workflowName}**) is paused on a provider usage or rate limit and ` +
      `tries again on its own at ${attention.resumeAt}; if the limit persists, it pauses ` +
      `again. It has no gate you can resolve. Resume it only if the user wants to try sooner: \`${cmd(`resume ${runId}`)}\`. ` +
      `Abandon it only if the user wants it stopped: \`${cmd(`abandon ${runId}`)}\`.`
    );
  }

  if (attention.kind === 'attention') {
    return (
      '## Paused, needs attention\n\n' +
      `Run \`${runId}\` (**${workflowName}**) is paused until it gets an answer in the '${attention.form}' form:\n\n` +
      `> ${attention.message.replace(/\n/g, '\n> ')}\n\n` +
      attentionAnswerLines(gate.surface ?? {}, attention).join('\n') +
      `\nAbandon it if it should not continue: \`${cmd(`abandon ${runId}`)}\`` +
      '\n\nOnly answer what the user actually decided; an undeclared option is refused.'
    );
  }

  // `awaiting_response`. The projection reports it only for a well-formed, unresolved
  // gate; the context read here carries the DETAIL the attention value omits.
  const rawApproval = gate.run.metadata.approval;
  const approval = isApprovalContext(rawApproval) ? rawApproval : undefined;

  const facts = [
    `- Run id: \`${runId}\``,
    `- Workflow: **${workflowName}**`,
    `- Gate node: \`${attention.respondTo.nodeId}\``,
  ];
  if (approval?.type === 'interactive_loop' && typeof approval.iteration === 'number') {
    facts.push(`- Loop iteration: ${String(approval.iteration)}`);
  }

  const authoredDecisions =
    (approval?.type === 'approval' || approval?.type === undefined) &&
    approval?.decisionsAuthored === true
      ? approval.decisions
      : undefined;
  const explicitCommands = authoredDecisions
    ? authoredDecisions.map(d => `\`${cmd(`respond ${runId} ${d.id} [text]`)}\``).join(' or ')
    : `\`${cmd(`approve ${runId} [comment]`)}\` or \`${cmd(`reject ${runId} <reason>`)}\``;

  const preamble =
    header +
    'A workflow run in this conversation is PAUSED waiting for a human decision. It does not ' +
    'continue until the gate is resolved.\n\n' +
    facts.join('\n') +
    (authoredDecisions
      ? '\n- Declared decisions: ' +
        authoredDecisions.map(d => `\`${d.id}\`${d.label ? ` (${d.label})` : ''}`).join(', ')
      : '') +
    '\n\nWhat the run is asking:\n\n' +
    `> ${attention.message.replace(/\n/g, '\n> ')}\n\n`;

  // No project is attached, so neither the `manage_run` tool nor the CLI-pointer
  // section is present this turn. Relay the gate rather than instructing the
  // agent to use verbs it does not have.
  if (gate.agentCanResolve === false) {
    return (
      preamble +
      'You have no way to resolve this gate yourself in this conversation — no project is ' +
      'attached, so the run-management verbs are not available. If the user is answering the ' +
      `gate, tell them to decide it explicitly with ${explicitCommands}. Do not claim you ` +
      'resolved anything.'
    );
  }

  // A container run can only be resumed where the container can be rewired. The
  // section promises continuation, and that promise is false here — the executor
  // refuses a resume it cannot rewire.
  const continuation = isContainerRun(gate.run)
    ? 'This run executed inside an isolation container, so resolving the gate records the ' +
      'decision but CANNOT continue the run from here — only the CLI can rewire the ' +
      `container. Tell the user to finish it with \`archon workflow resume ${runId}\` ` +
      'from the CLI in the same project.'
    : 'Resolving the gate also continues the run — there is no separate resume step.';

  if (authoredDecisions) {
    return (
      preamble +
      "Read the user's full message and judge which declared decision, if any, it expresses. " +
      'Use the respond action with that exact declared ID and pass their own words verbatim as text. ' +
      'Only these declared IDs are accepted. If the message asks a question, is unrelated, or does not ' +
      'clearly select a decision, resolve NOTHING. Answer them or ask for clarification and leave the gate open. ' +
      'An unambiguous decision is the human confirmation: resolve it in the same turn.\n\n' +
      continuation +
      ` The user can always decide it themselves with ${explicitCommands}.`
    );
  }

  return (
    preamble +
    "Read the user's message and judge what it means for THIS gate:\n\n" +
    '- It clearly approves → resolve the gate as APPROVED, passing their own words verbatim as ' +
    'the comment (a workflow may read that comment as the gate node’s output).\n' +
    '- It clearly objects, refuses, or asks to stop → resolve the gate as REJECTED, passing ' +
    'their own words verbatim as the reason.\n' +
    '- Anything else — a question, a request for detail, an unrelated message → resolve ' +
    'NOTHING. Answer them and leave the gate open.\n\n' +
    // Demonstration, not just the rule: the reason a rejection carries is what an
    // on_reject prompt reworks the code from, so a paraphrase there is a different
    // artifact from what the user asked for.
    'The words that travel are the user’s, not your summary:\n\n' +
    '  User: "no, stop — why is it editing the schema?"\n' +
    '  → REJECT, reason: "no, stop — why is it editing the schema?"\n' +
    '    (NOT "the user objected to the schema change" — the reason is what an on_reject\n' +
    '     prompt reworks from, so a summary reworks the wrong thing.)\n\n' +
    '  User: "looks good, but add error handling for the edge cases"\n' +
    '  → APPROVE, comment: "looks good, but add error handling for the edge cases"\n\n' +
    'An unambiguous decision from the user IS the human confirmation a gate action needs — ' +
    'resolve it in the same turn rather than making them repeat themselves. When you are not ' +
    'sure what they meant, ask: leaving the gate open costs nothing, and resolving it against ' +
    'their intent cannot be undone.\n\n' +
    continuation +
    ` The user can always decide it themselves with ${explicitCommands}.`
  );
}

/** The provider transport for launching and managing workflow runs. */
export type LaunchChannel = 'tools' | 'cli';

/**
 * Build the routing rules section, optionally scoped to a specific project.
 * When projectName is provided, rule #4 defaults to that project instead of asking.
 */
export function buildRoutingRulesWithProject(channel: LaunchChannel, projectName?: string): string {
  const rule4 = projectName
    ? `4. If ambiguous which project → use **${projectName}** (the active project)`
    : '4. If ambiguous which project → ask the user';
  const workspaces = getArchonWorkspacesPath();

  const routingRules = `## Routing Rules

1. If the user asks a question, wants to explore code, or needs help → answer directly
2. If the user wants structured development work → invoke the appropriate workflow
3. If the user mentions a specific project → use that project's name
${rule4}
5. If no project needed (general question) → answer directly without workflow
6. If the user wants to add a new project → clone it, then register it (see below)

In the examples below, {workflow-name} is an illustrative placeholder: replace it with the exact name of an appropriate workflow from Available Workflows. Never invoke the placeholder literally. If no listed workflow fits, explain that instead of inventing a name. Identify the closest available option and its limits, offer to author a workflow for repeatable work, or suggest using a coding agent directly for one-off work. Do not recommend deprecated workflows when a non-deprecated workflow fits; follow the deprecation guidance in Available Workflows.`;

  const promptRules = (
    arg: string
  ): string => `- The ${arg} MUST be a complete, self-contained task description that fully captures the user's intent.
- Synthesize the prompt from conversation context — do NOT use vague references like "do what we discussed" or "yes, go ahead."
- The prompt should make sense to someone with NO knowledge of the conversation history.`;

  const exampleTask =
    'Fix GitHub issue #42: the login form rejects valid email addresses. Check the issue against the current code, fix the root cause, and open a reviewed pull request.';

  const projectMaintenance = `Ask the user to submit these project-maintenance commands in this conversation.
To update a project's path:
   /update-project {project-name} {new-path}

To remove a registered project:
   /remove-project {project-name}

Before cloning, choose an unoccupied source path. Prefer ${workspaces}/{owner}/{repo}/source; if occupied, choose a readable suffix such as ${workspaces}/{owner}/{repo}-2/source. Honor a user-specified location, but never overwrite an occupied checkout.
Use the name returned by registration for subsequent workflow and project commands; registration may add a suffix. Two clones of one registered remote cannot be separate projects; use worktrees for parallel checkouts.`;

  const projectSelection = `## Project Selection

Ask the user to submit \`/setproject <name>\` in this conversation or thread to persist its active project and enable project run management. Registration alone does not bind the conversation. General questions work without a project.
${!projectName && channel === 'cli' ? 'Before launching or managing runs, ask the user to select a registered project with /setproject <name>.' : 'If a requested project is ambiguous, ask which project the user means.'}`;

  if (channel === 'tools') {
    const invokeExample = {
      workflow: '{workflow-name}',
      project: 'my-project',
      prompt: exampleTask,
      inputs: '{"base_branch":"dev"}',
    } satisfies Record<keyof typeof INVOKE_WORKFLOW_SCHEMA.properties, string>;
    const registerExample = {
      name: 'my-new-app',
      path: `${workspaces}/user/my-new-app/source`,
      folder: false,
    } satisfies Record<keyof typeof REGISTER_PROJECT_SCHEMA.properties, string | boolean>;
    return `${routingRules}

${projectSelection}

## Invoking a Workflow

To invoke a workflow, call the \`invoke_workflow\` tool with:
${Object.entries(INVOKE_WORKFLOW_SCHEMA.properties)
  .map(([name, property]) => `- \`${name}\`: ${property.description}`)
  .join('\n')}

Rules:
${promptRules('`prompt`')}
- If the chosen workflow lists inputs, pass the values the user gave in \`inputs\`. If a required input is missing, ask the user for it before calling \`invoke_workflow\`.
- Call \`invoke_workflow\` at most once per reply. The run starts after your reply ends: say what you launched, and never claim the run finished.

Routing behavior:
- If the user clearly wants work done (e.g., "create a plan for X", "implement Y", "fix Z") → briefly explain what you're doing and call \`invoke_workflow\`.
- If the user is asking a question or it's unclear whether they want a workflow → answer their question directly. You may offer to run a suitable workflow from Available Workflows if one fits, but do NOT call \`invoke_workflow\`.

Example (clear intent):
User: "Fix issue #42, the login form rejects valid emails"
Response: I'll take issue #42 through to a reviewed pull request.
invoke_workflow(${INVOKE_WORKFLOW_SCHEMA.required.map(name => `${name}: "${invokeExample[name]}"`).join(', ')})

Example (ambiguous — answer directly):
User: "What do you think about adding dark mode?"
Response: "Adding dark mode would involve... [answer the question]. If you'd like me to create a plan for this, I can run one if a suitable workflow is available." Do NOT call \`invoke_workflow\`.

## Project Setup

When a user asks to register an existing local directory, call the \`register_project\` tool with ${REGISTER_PROJECT_SCHEMA.required.map(name => `\`${name}\``).join(' and ')}.
Pass \`folder: true\` when the user wants Archon to run in place without managing git.
A folder project may itself be a git repository. Git belongs to the user and agent.
Without \`folder\`, git paths are repo projects and non-git paths are folder projects.

When a user asks to clone a new repository:
1. Following the path guidance below, choose an unoccupied source path under ${workspaces}/:
   git clone https://github.com/{owner}/{repo} "{unoccupied-source-path}"
2. Register it by calling \`register_project\` with the project name and the path to \`source\`, e.g.
   register_project(${REGISTER_PROJECT_SCHEMA.required.map(name => `${name}: "${registerExample[name]}"`).join(', ')})

${projectMaintenance}`;
  }

  return `${routingRules}

${projectSelection}

## Workflow Launch via CLI

${projectName ? 'Launch only when the user clearly requests work and a listed workflow fits. Use the existing CLI in the registered project directory.' : 'Once the user selects a project, use the existing CLI in its registered directory. Do not launch from the projectless workspace.'}
- Use \`archon workflow run <workflow> "<message>" --detach\`.
${promptRules('message argument')}
- Pass declared workflow inputs with \`--input name=value\` for each value. Ask for missing required inputs before launching.
- Quote every shell argument safely, including paths, task text and inputs. Preserve embedded quotes and apostrophes; never interpolate user text as shell code.
- Use the selected project's listed directory. If the user explicitly chooses another project, change to that project's listed directory first.
- Launch at most once per reply. For questions or unclear intent, answer directly without launching.
- Detached launches are headless: they use CLI identity, have no originating-chat progress or result delivery, and return a run ID. Inspect that ID with the CLI; never claim the run has finished just because launch returned.

## Project Setup

Ask the user to submit an explicit command:
   /register-project {project-name} "{path}"
For in-place execution without Archon-managed git:
   /register-project --folder {project-name} "{path}"
A folder project may itself be a git repository. Without --folder, git paths are repo projects and non-git paths are folder projects.
Displaying a command does not execute it. After registration, ask the user to submit /setproject <name> in this conversation.

When asked to clone a repository, choose an unoccupied source path following the guidance below:
   git clone https://github.com/{owner}/{repo} "{unoccupied-source-path}"
Then ask the user to submit:
   /register-project {project-name} {path-to-source}
For example:
   /register-project my-new-app ${workspaces}/user/my-new-app/source

${projectMaintenance}`;
}

/**
 * Build the full orchestrator system prompt.
 * Includes all registered projects, available workflows, and routing instructions.
 */
export function buildOrchestratorPrompt(
  codebases: readonly Codebase[],
  workflows: readonly PromptWorkflow[],
  channel: LaunchChannel
): string {
  let prompt = `# Archon Orchestrator

You are Archon, an intelligent coding assistant that manages multiple projects.
Your working directory is ${getArchonWorkspacesPath()}/ where all projects live.
You can answer questions directly or invoke workflows for structured development tasks.

## Registered Projects

`;

  if (codebases.length === 0) {
    prompt +=
      'No projects registered yet. Ask the user to add a project or clone a repository.\n\n';
  } else {
    for (const codebase of codebases) {
      prompt += formatProjectSection(codebase);
      prompt += '\n';
    }
  }

  prompt += '## Available Workflows\n\n';
  prompt += formatWorkflowSection(workflows);

  prompt += buildRoutingRulesWithProject(channel);

  return prompt;
}

/**
 * Build a project-scoped orchestrator system prompt.
 * The scoped project is shown prominently; other projects are listed separately.
 * Routing rules default to the scoped project when ambiguous.
 */
export async function buildProjectScopedPrompt(
  scopedCodebase: Codebase,
  allCodebases: readonly Codebase[],
  workflows: readonly PromptWorkflow[],
  channel: LaunchChannel
): Promise<string> {
  const otherCodebases = allCodebases.filter(c => c.id !== scopedCodebase.id);

  let prompt = `# Archon Orchestrator

You are Archon, an intelligent coding assistant that manages multiple projects.
Your working directory is ${getArchonWorkspacesPath()}/ where all projects live.
You can answer questions directly or invoke workflows for structured development tasks.

This conversation is scoped to **${scopedCodebase.name}**. Use this project for all workflow invocations unless the user explicitly mentions a different project.

## Active Project

${formatProjectSection(scopedCodebase, await resolveProjectAssistant(scopedCodebase))}
`;

  if (otherCodebases.length > 0) {
    prompt += '## Other Registered Projects\n\n';
    for (const codebase of otherCodebases) {
      prompt += formatProjectSection(codebase);
      prompt += '\n';
    }
  }

  prompt += '## Available Workflows\n\n';
  prompt += formatWorkflowSection(workflows);

  prompt += buildRoutingRulesWithProject(channel, scopedCodebase.name);

  return prompt;
}

/** CLI transport for inspecting and controlling runs in a registered project. */
export function buildRunManagementSection(codebaseId?: string): string {
  return `## Managing Workflow Runs

You can inspect and control this project's workflow runs directly via the \`archon\` CLI (bash) — you do NOT need to invoke a workflow for run management. Add \`--json\` to any command for a single clean, machine-readable line.

${codebaseId ? `Prefix every by-ID command below with \`ARCHON_WORKFLOW_CODEBASE_ID=${codebaseId}\` so the CLI refuses runs outside the selected project. ` : ''}Run these from the registered project directory (repo or folder). Use its listed path, not the projectless workspace at \`${getArchonWorkspacesPath()}/\`. Project scope applies to \`runs\` and \`status\`; use \`--all\` only when the user asks for install-wide visibility.

- \`archon workflow runs [--json]\` — recent runs of ALL statuses for this project
- \`archon workflow get <run-id> [--json]\` — one run's status/error (add \`--verbose\` for per-node detail)
- \`archon workflow status [--json]\` — active runs only (running/paused) for this project; add \`--all\` only for install-wide visibility
- \`archon workflow run <workflow> "<message>" --detach\` — start a run in the background (returns immediately)
- \`archon workflow approve <run-id> [comment]\` / \`archon workflow reject <run-id> [reason]\` — resolve a paused approval gate AND continue the run in one step. Pass the user's own words as the comment or reason, never a summary: a workflow may read the comment as the gate node's output, and the reason is what an \`on_reject\` prompt reworks from. Add \`--json\` only when you need a machine-readable ack: \`--json\` records the decision WITHOUT continuing, and you must then drive \`archon workflow resume <run-id>\` yourself or the run stays stranded.
- \`archon workflow respond <run-id> <decision> [text]\` — same shape as approve/reject, but for a gate that declares decisions beyond the default pair (check the paused run's message for the declared options). \`approve\`/\`reject\` remain the shortcuts above; use \`respond\` only when the gate offers a different vocabulary.
- \`archon workflow resume <run-id>\` — re-run a failed/paused run, skipping completed nodes (run as a background task; \`--json\` validates only)
- \`archon workflow cancel <run-id> [--json]\` — stop a running run: a run another process owns has that process stopped first; a sub-run with no owner of its own stops at its root's next status check when the root's owner answers; it refuses (pointing at abandon) when no owner answers
- \`archon workflow abandon <run-id> [--json]\` — discard a run whose owner is gone: it stops a live detached owner first, and when no owner answers it records \`cancelled\` and prints the host and pid the run recorded

When the user asks what's running, whether a run passed/failed, or to approve / reject / resume / cancel a run, use these commands directly instead of invoking a workflow. The \`manage-run\` skill has the full reference if it is loaded.`;
}

/** Build cacheable chat context with the selected launch and run-management transport. */
export async function buildOrchestratorSystemAppend(
  conversation: Conversation,
  codebases: readonly Codebase[],
  workflows: readonly PromptWorkflow[],
  channel: LaunchChannel
): Promise<string> {
  const scopedCodebase = conversation.codebase_id
    ? codebases.find(c => c.id === conversation.codebase_id)
    : undefined;

  const prompt = await (scopedCodebase
    ? buildProjectScopedPrompt(scopedCodebase, codebases, workflows, channel)
    : buildOrchestratorPrompt(codebases, workflows, channel));
  return scopedCodebase && channel === 'cli'
    ? `${prompt}\n\n${buildRunManagementSection(scopedCodebase.id)}`
    : prompt;
}
