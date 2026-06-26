/**
 * Orchestrator prompt builder
 * Constructs the system prompt for the orchestrator agent with all
 * registered projects and available workflows.
 */
import type { Codebase, Conversation } from '../types';
import type { WorkflowDefinition } from '@archon/workflows/schemas/workflow';

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
export function formatWorkflowSection(workflows: readonly WorkflowDefinition[]): string {
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
  workflows: readonly WorkflowDefinition[]
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
  workflows: readonly WorkflowDefinition[]
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
- \`archon workflow approve <run-id> [--json]\` / \`archon workflow reject <run-id> [reason] [--json]\` — resolve a paused approval gate
- \`archon workflow resume <run-id>\` — re-run a failed/paused run, skipping completed nodes (run as a background task; \`--json\` validates only)
- \`archon workflow abandon <run-id> [--json]\` — cancel a non-terminal run

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
  workflows: readonly WorkflowDefinition[]
): string {
  const scopedCodebase = conversation.codebase_id
    ? codebases.find(c => c.id === conversation.codebase_id)
    : undefined;

  return scopedCodebase
    ? buildProjectScopedPrompt(scopedCodebase, codebases, workflows)
    : buildOrchestratorPrompt(codebases, workflows);
}
