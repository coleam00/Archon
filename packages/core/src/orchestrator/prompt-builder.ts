/**
 * Orchestrator prompt builder
 * Constructs the system prompt for the orchestrator agent with all
 * registered projects and available workflows.
 */
import type { Codebase, Conversation } from '../types';
import type { WorkflowDefinition } from '@archon/workflows/schemas/workflow';
import {
  isApprovalContext,
  isContainerRun,
  runAttention,
} from '@archon/workflows/schemas/workflow-run';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';

type PromptWorkflow = Pick<WorkflowDefinition, 'name' | 'description'> & {
  readonly nodes: readonly unknown[];
};

/**
 * Format a single project for the orchestrator prompt.
 */
export function formatProjectSection(codebase: Codebase): string {
  let section = `### ${codebase.name}\n`;
  if (codebase.repository_url) {
    section += `- Repository: ${codebase.repository_url}\n`;
  }
  section += `- Directory: ${codebase.default_cwd}\n`;
  section += `- AI Provider: ${codebase.ai_assistant_type}\n`;
  return section;
}

/**
 * Format workflow list for the orchestrator prompt.
 */
export function formatWorkflowSection(workflows: readonly PromptWorkflow[]): string {
  if (workflows.length === 0) {
    return 'No workflows available. Users can create workflows in `.archon/workflows/` as YAML files.\n';
  }

  let section = '';
  for (const w of workflows) {
    section += `**${w.name}**\n`;
    section += `  ${w.description}\n`;
    section += `  Type: DAG (${String(w.nodes.length)} nodes)\n`;
    section += '\n';
  }
  return section;
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
}

/**
 * Format the "there is a human gate waiting in this conversation" section.
 *
 * This is the ONLY thing that tells the chat agent a gate is open. It states the
 * facts of the gate and the decision policy; it does NOT name a tool, because the
 * verbs reach different providers by different routes (the `manage_run` native
 * tool on Claude/Pi, the `archon workflow approve|reject` CLI section on the
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

  // Nothing needs a person: a resolved gate awaiting resume, a durable `wait:`, or a
  // run that already finished. Offering any of those to the agent invites a second
  // decision the operations reject.
  if (attention === null || attention.kind === 'terminal') return '';

  if (attention.kind === 'unreadable') {
    // Paused, but the gate cannot be described — unreadable metadata, or a gate type
    // this build cannot resolve. Preserve the explicit-command guidance the old
    // natural-language branch sent directly to the user.
    return (
      header +
      `Run \`${runId}\` (**${workflowName}**) is paused, but its approval context is ` +
      'missing or malformed, so the gate cannot be described. Tell the user to resolve it ' +
      `explicitly with \`/workflow approve ${runId}\` or \`/workflow reject ${runId} <reason>\`.`
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

  const explicitCommands = `\`/workflow approve ${runId} [comment]\` or \`/workflow reject ${runId} <reason>\``;

  const preamble =
    header +
    'A workflow run in this conversation is PAUSED waiting for a human decision. It does not ' +
    'continue until the gate is resolved.\n\n' +
    facts.join('\n') +
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

/**
 * Build the routing rules section of the prompt.
 */
export function buildRoutingRules(): string {
  return buildRoutingRulesWithProject();
}

/**
 * Build the routing rules section, optionally scoped to a specific project.
 * When projectName is provided, rule #4 defaults to that project instead of asking.
 */
export function buildRoutingRulesWithProject(projectName?: string): string {
  const rule4 = projectName
    ? `4. If ambiguous which project → use **${projectName}** (the active project)`
    : '4. If ambiguous which project → ask the user';

  return `## Routing Rules

1. If the user asks a question, wants to explore code, or needs help → answer directly
2. If the user wants structured development work → invoke the appropriate workflow
3. If the user mentions a specific project → use that project's name
${rule4}
5. If no project needed (general question) → answer directly without workflow
6. If the user wants to add a new project → clone it, then register it (see below)

## Workflow Invocation Format

When invoking a workflow, output the command as the VERY LAST line of your response:
/invoke-workflow {workflow-name} --project {project-name} --prompt "{task description}"

Rules:
- Use the project NAME (e.g., "my-project"), not an ID or path.
- The --prompt MUST be a complete, self-contained task description that fully captures the user's intent.
- Synthesize the prompt from conversation context — do NOT use vague references like "do what we discussed" or "yes, go ahead."
- The prompt should make sense to someone with NO knowledge of the conversation history.
- You may include a brief explanation before the command. The user will see this text.
- /invoke-workflow MUST be the absolute last thing in your response. Do NOT use any tools or generate additional text after it.

Routing behavior:
- If the user clearly wants work done (e.g., "create a plan for X", "implement Y", "fix Z") → include a brief explanation of what you're doing, then invoke the workflow.
- If the user is asking a question or it's unclear whether they want a workflow → answer their question directly. You may suggest a workflow by name (e.g., "I can run the **archon-assist** workflow for this if you'd like"), but do NOT include /invoke-workflow in your response.

Example (clear intent):
I'll analyze the orchestrator module architecture for you.
/invoke-workflow archon-assist --project my-project --prompt "Analyze the orchestrator module architecture: explain how it routes messages, manages sessions, and dispatches workflows to AI clients"

Example (ambiguous — answer directly):
User: "What do you think about adding dark mode?"
Response: "Adding dark mode would involve... [answer the question]. If you'd like me to create a plan for this, I can run the **archon-idea-to-pr** workflow."

## Project Setup

When a user asks to add a new project:
1. Clone the repository into ~/.archon/workspaces/:
   git clone https://github.com/{owner}/{repo} ~/.archon/workspaces/{owner}/{repo}/source
2. Register it by emitting this command on its own line:
   /register-project {project-name} {path-to-source}

Example:
   /register-project my-new-app /home/user/.archon/workspaces/user/my-new-app/source

To update a project's path:
   /update-project {project-name} {new-path}

To remove a registered project:
   /remove-project {project-name}

IMPORTANT: Always clone into ~/.archon/workspaces/{owner}/{repo}/source unless the user specifies a different location.`;
}

/**
 * Build the full orchestrator system prompt.
 * Includes all registered projects, available workflows, and routing instructions.
 */
export function buildOrchestratorPrompt(
  codebases: readonly Codebase[],
  workflows: readonly PromptWorkflow[]
): string {
  let prompt = `# Archon Orchestrator

You are Archon, an intelligent coding assistant that manages multiple projects.
Your working directory is ~/.archon/workspaces/ where all projects live.
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

  prompt += buildRoutingRules();

  return prompt;
}

/**
 * Build a project-scoped orchestrator system prompt.
 * The scoped project is shown prominently; other projects are listed separately.
 * Routing rules default to the scoped project when ambiguous.
 */
export function buildProjectScopedPrompt(
  scopedCodebase: Codebase,
  allCodebases: readonly Codebase[],
  workflows: readonly PromptWorkflow[]
): string {
  const otherCodebases = allCodebases.filter(c => c.id !== scopedCodebase.id);

  let prompt = `# Archon Orchestrator

You are Archon, an intelligent coding assistant that manages multiple projects.
Your working directory is ~/.archon/workspaces/ where all projects live.
You can answer questions directly or invoke workflows for structured development tasks.

This conversation is scoped to **${scopedCodebase.name}**. Use this project for all workflow invocations unless the user explicitly mentions a different project.

## Active Project

${formatProjectSection(scopedCodebase)}
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

  prompt += buildRoutingRulesWithProject(scopedCodebase.name);

  return prompt;
}

/**
 * Build the run-management section of the orchestrator prompt.
 *
 * Teaches the chat agent it can inspect and control workflow runs directly via
 * the `archon` CLI over bash — the delivery of the `manage-run` skill for
 * providers WITHOUT the in-process `manage_run` tool. Direct chat is the one path
 * where the `skills:` option is NOT consumed (it is workflow-node-only), so the
 * system prompt is the only channel that reaches Codex/OpenCode/Copilot. The
 * orchestrator (orchestrator-agent.ts) appends this ONLY for project-scoped chats
 * on non-nativeTools providers — Claude/Pi use the native tool instead, and the
 * CLI commands require a git-repo cwd that unscoped chats don't have. Invocation
 * inherits the same `archon`-on-PATH convention the `archon` skill already assumes.
 */
export function buildRunManagementSection(): string {
  return `## Managing Workflow Runs

You can inspect and control this project's workflow runs directly via the \`archon\` CLI (bash) — you do NOT need to invoke a workflow for run management. Add \`--json\` to any command for a single clean, machine-readable line.

Run these from within the project's git repo (any subdirectory works — they resolve to the repo root, which also scopes \`runs\` to this project). They fail with "Not in a git repository" if the working directory is \`~/.archon/workspaces/\` or another non-repo path.

- \`archon workflow runs [--json]\` — recent runs of ALL statuses for this project
- \`archon workflow get <run-id> [--json]\` — one run's status/error (add \`--verbose\` for per-node detail)
- \`archon workflow status [--json]\` — active runs only (running/paused)
- \`archon workflow run <workflow> "<message>" --detach\` — start a run in the background (returns immediately)
- \`archon workflow approve <run-id> [comment]\` / \`archon workflow reject <run-id> [reason]\` — resolve a paused approval gate AND continue the run in one step. Pass the user's own words as the comment or reason, never a summary: a workflow may read the comment as the gate node's output, and the reason is what an \`on_reject\` prompt reworks from. Add \`--json\` only when you need a machine-readable ack: \`--json\` records the decision WITHOUT continuing, and you must then drive \`archon workflow resume <run-id>\` yourself or the run stays stranded.
- \`archon workflow respond <run-id> <decision> [text]\` — same shape as approve/reject, but for a gate that declares decisions beyond the default pair (check the paused run's message for the declared options). \`approve\`/\`reject\` remain the shortcuts above; use \`respond\` only when the gate offers a different vocabulary.
- \`archon workflow resume <run-id>\` — re-run a failed/paused run, skipping completed nodes (run as a background task; \`--json\` validates only)
- \`archon workflow cancel <run-id> [--json]\` — actively stop a running CLI \`--detach\` owner, then record \`cancelled\`
- \`archon workflow abandon <run-id> [--json]\` — state-only cancellation for paused runs or verified orphans; it does not stop host work

When the user asks what's running, whether a run passed/failed, or to approve / reject / resume / cancel a run, use these commands directly instead of invoking a workflow. The \`manage-run\` skill has the full reference if it is loaded.`;
}

/**
 * Build the static orchestrator context string for use as a cacheable system prompt append.
 * Returns the same content as buildOrchestratorPrompt/buildProjectScopedPrompt depending
 * on whether the conversation is scoped to a project. The run-management section is NOT
 * appended here — the orchestrator adds it conditionally (project-scoped + non-nativeTools
 * providers) via buildRunManagementSection().
 */
export function buildOrchestratorSystemAppend(
  conversation: Conversation,
  codebases: readonly Codebase[],
  workflows: readonly PromptWorkflow[]
): string {
  const scopedCodebase = conversation.codebase_id
    ? codebases.find(c => c.id === conversation.codebase_id)
    : undefined;

  return scopedCodebase
    ? buildProjectScopedPrompt(scopedCodebase, codebases, workflows)
    : buildOrchestratorPrompt(codebases, workflows);
}
