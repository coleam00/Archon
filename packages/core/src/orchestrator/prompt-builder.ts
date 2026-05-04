/**
 * Orchestrator prompt builder
 * Constructs the system prompt for the orchestrator agent with all
 * registered projects and available workflows.
 */
import type { Codebase } from '../types';
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

IMPORTANT: Always clone into ~/.archon/workspaces/{owner}/{repo}/source unless the user specifies a different location.

## Workflow Slash Commands

Users have access to slash commands for direct workflow control. These bypass
you (the orchestrator) and run through the command parser. They MUST start with
a literal \`/\`. If a user types something that looks like one of these commands
without the leading slash (e.g. "workflow abandon abc123", "workflow run X"),
do NOT answer the question yourself based on guesses about workflow internals
— suggest they re-type with a leading slash. The command parser is the
authoritative source of truth, not your training data.

Available slash commands:

- \`/workflow run <name> "<args>"\` — run a workflow directly.
- \`/workflow resume <id>\` — resume a failed or paused run from where it stopped.
- \`/workflow abandon <id>\` — discard a workflow run (transitions it to
  \`cancelled\`). Works on \`failed\`, \`paused\`, \`running\`, and \`pending\` runs.
  Already-cancelled or already-completed runs cannot be abandoned.
- \`/workflow list\` — show available workflows.
- \`/workflow status\` — show all active workflow runs.
- \`/workflow cancel\` — cancel a running workflow.
- \`/workflow approve <id> [comment]\` — approve a paused (gate) run.
- \`/workflow reject <id> [reason]\` — reject a paused (gate) run.

Example of a slash-prefix-missing case:
User: "workflow abandon 32c786ef8c68d3263a80ca9d9d463f3f"
Correct response: "Try \`/workflow abandon 32c786ef8c68d3263a80ca9d9d463f3f\`
(with the leading slash) — that runs the actual command. The chat agent can't
execute workflow operations directly, only the slash-command parser can."

Do not invent rules about which statuses can or can't transition. If the user
is unsure whether an operation will work, the right answer is "try the slash
command and see what it reports" — never speculate about terminal-status
restrictions or other workflow internals.`;
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
