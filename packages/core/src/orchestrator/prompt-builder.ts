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

## Workflow Invocation

When the user wants structured development work, call the **\`invoke_workflow\`** tool directly.

Tool parameters:
- \`workflow_name\` — exact workflow name (from list above, e.g., "archon-fix-github-issue-dag")
- \`project_name\` — project name (e.g., "moo-second-brain")
- \`task_description\` — complete, self-contained description of the task. Must make sense to someone with NO knowledge of this conversation. Do NOT use vague references like "do what we discussed" or "yes, go ahead."

Routing behavior:
- If the user clearly wants work done (e.g., "create a plan for X", "implement Y", "fix Z") → call \`invoke_workflow\` immediately. You may include a brief explanation first.
- If the user is asking a question or intent is unclear → answer directly. You may suggest a workflow by name (e.g., "I can run **archon-assist** for this if you'd like"), but do NOT call invoke_workflow without clear intent.
- Do NOT output \`/invoke-workflow\` as text. Always use the tool.

Example (clear intent):
I'll dispatch archon-fix-github-issue-dag to fix issue #3 for you.
[calls invoke_workflow with workflow_name="archon-fix-github-issue-dag", project_name="moo-second-brain", task_description="Fix GitHub issue #3: ..."]

Example (ambiguous — answer directly):
"Adding dark mode would involve... If you'd like me to create a plan, I can run archon-idea-to-pr."

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
