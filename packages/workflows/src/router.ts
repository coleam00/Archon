/**
 * Workflow Router - builds prompts and detects workflow invocation
 */
import type { WorkflowDefinition } from './schemas';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.router');
  return cachedLog;
}

/**
 * Optional context for router to make informed decisions.
 * Constructed by the orchestrator from platform type, issue context strings, and isolation hints.
 */
export interface RouterContext {
  /** Platform type identifier from the adapter (e.g., 'github', 'slack', 'telegram', 'test') */
  platformType?: string;
  /** Whether this is a PR vs issue - currently only relevant for GitHub */
  isPullRequest?: boolean;
  /** Issue or PR title */
  title?: string;
  /** Issue or PR labels */
  labels?: string[];
  /** Thread/comment history - previous messages for context */
  threadHistory?: string;
  /** Workflow type hint (e.g., 'pr-review', 'issue', etc.) */
  workflowType?: string;
}

/**
 * Build the context section for the router prompt.
 * Returns formatted lines for each context property present (platform, type, title, labels, history).
 * Returns empty string if context is undefined or has no populated properties.
 */
function buildContextSection(context?: RouterContext): string {
  if (!context) return '';

  const parts: string[] = [];

  if (context.platformType) {
    parts.push(`Platform: ${context.platformType}`);
  }

  if (context.isPullRequest !== undefined) {
    parts.push(`Type: ${context.isPullRequest ? 'Pull Request' : 'Issue'}`);
  } else if (context.workflowType) {
    parts.push(`Type: ${context.workflowType}`);
  }

  if (context.title) {
    parts.push(`Title: ${context.title}`);
  }

  if (context.labels && context.labels.length > 0) {
    parts.push(`Labels: ${context.labels.join(', ')}`);
  }

  if (context.threadHistory) {
    parts.push(`\nThread History:\n${context.threadHistory}`);
  }

  return parts.length > 0 ? parts.join('\n') : '';
}

/**
 * Build the router prompt with available workflows and optional context.
 * Context helps the router make better routing decisions by understanding the situation.
 * Instructs AI to use /invoke-workflow command.
 */
export function buildRouterPrompt(
  userMessage: string,
  workflows: readonly WorkflowDefinition[],
  context?: RouterContext
): string {
  if (workflows.length === 0) {
    // No workflows - just respond conversationally
    return userMessage;
  }

  const workflowList = workflows
    .map(w => {
      // Format description, handling multi-line descriptions
      const desc = w.description.trim().replace(/\n/g, '\n  ');
      return `**${w.name}**\n  ${desc}`;
    })
    .join('\n\n');

  const contextSection = buildContextSection(context);

  // Build prompt with or without context section
  const contextPart = contextSection
    ? `## Context

${contextSection}

`
    : '';

  return `# Workflow Router

You are a router. Your job is to pick the best workflow for the user's request.

${contextPart}## Available Workflows

${workflowList}

## User Request

"${userMessage}"

## Rules

1. The USER REQUEST is the PRIMARY signal — it determines which workflow to use
2. The CONTEXT section is supplementary — it tells you WHERE the user is, not WHAT they want
3. Read each workflow's description - especially the "NOT for" and "Use when" sections
4. CRITICAL: Being on a GitHub issue does NOT mean the user wants to fix it. Only route to "fix-github-issue" if the user EXPLICITLY asks to fix, resolve, or implement something.
5. IMPORTANT distinctions:
   - CI failures, test failures, build errors, linting issues → use "assist" (debugging help)
   - "Fix this issue" / "implement this" / "resolve this bug" (explicit action request) → use "fix-github-issue"
   - Questions, exploration, explanations, general messages → use "assist"
   - PR reviews, code reviews → check for a PR review workflow in the list above
6. If unsure, prefer "assist" (the catch-all)
7. You MUST pick a workflow - never respond with just text

## Response Format

Your ENTIRE response must be ONLY this single line - no analysis, no explanation, no context:
/invoke-workflow {workflow-name}

Do NOT include any other text before or after. Just the command.
Do NOT use any tools (Read, Write, Bash, etc.) — this is a routing decision only.`;
  // NOTE: We emphasize "ONLY this single line" because AI models sometimes add analysis
  // before the command. The parseWorkflowInvocation regex uses multiline mode as a fallback,
  // but cleaner output is preferred for GitHub comments where the full response is posted.
}

/**
 * Result of parsing a message for workflow invocation
 */
export interface WorkflowInvocation {
  workflowName: string | null;
  remainingMessage: string;
  /** Error message when workflow name was detected but didn't match */
  error?: string;
}

/**
 * Parse a message to detect /invoke-workflow command
 */
export function parseWorkflowInvocation(
  message: string,
  workflows: readonly WorkflowDefinition[]
): WorkflowInvocation {
  const trimmed = message.trim();

  // Check for /invoke-workflow pattern (at start of any line)
  // Uses multiline flag ('m') because AI models sometimes add analysis text before the command
  // despite instructions to only output the command. This ensures routing still works.
  const match = /^\/invoke-workflow\s+(\S+)/im.exec(trimmed);

  if (match) {
    const workflowName = match[1];

    // Exact match
    const workflow = workflows.find(w => w.name === workflowName);
    if (workflow) {
      // Use match.index to handle multiline matches where command isn't at position 0
      const remainingMessage = trimmed.slice(match.index + match[0].length).trim();
      return { workflowName, remainingMessage };
    }

    // Case-insensitive match
    const caseMatch = workflows.find(w => w.name.toLowerCase() === workflowName.toLowerCase());
    if (caseMatch) {
      getLog().info(
        { requested: workflowName, matched: caseMatch.name },
        'workflow.invoke_case_insensitive_match'
      );
      const remainingMessage = trimmed.slice(match.index + match[0].length).trim();
      return { workflowName: caseMatch.name, remainingMessage };
    }

    // No match - build helpful error
    const available = workflows.map(w => w.name);
    getLog().warn({ workflowName, available }, 'workflow.invoke_unknown');

    return {
      workflowName: null,
      remainingMessage: message,
      error: `Unknown workflow: \`${workflowName}\`. Available: ${available.map(n => `\`${n}\``).join(', ')}`,
    };
  }

  return {
    workflowName: null,
    remainingMessage: message,
  };
}

/**
 * Find a workflow by name
 */
export function findWorkflow(
  name: string,
  workflows: readonly WorkflowDefinition[]
): WorkflowDefinition | undefined {
  return workflows.find(w => w.name === name);
}

/**
 * Resolve a workflow by name using a 4-tier fallback hierarchy:
 * 1. Exact match
 * 2. Case-insensitive match
 * 3. Suffix match (e.g. "assist" → "archon-assist")
 * 4. Substring match (e.g. "smart" → "archon-smart-pr-review")
 *
 * Returns the matched workflow, or undefined if no match found.
 * Throws an Error if multiple workflows match at the same tier (ambiguous).
 */
export function resolveWorkflowName(
  name: string,
  workflows: readonly WorkflowDefinition[]
): WorkflowDefinition | undefined {
  // Tier 1: Exact match
  const exact = workflows.find(w => w.name === name);
  if (exact) return exact;

  const lowerName = name.toLowerCase();

  // Returns the single match, throws on ambiguity, returns undefined for no match
  function checkTier(
    matches: WorkflowDefinition[],
    logEvent: string
  ): WorkflowDefinition | undefined {
    if (matches.length === 1) {
      getLog().info({ requested: name, matched: matches[0].name }, logEvent);
      return matches[0];
    }
    if (matches.length > 1) {
      const candidates = matches.map(w => `  - ${w.name}`).join('\n');
      throw new Error(`Ambiguous workflow '${name}'. Did you mean:\n${candidates}`);
    }
    return undefined;
  }

  return (
    // Tier 2: Case-insensitive match
    checkTier(
      workflows.filter(w => w.name.toLowerCase() === lowerName),
      'workflow.resolve_case_insensitive_match'
    ) ??
    // Tier 3: Suffix match (e.g. "assist" matches "archon-assist")
    checkTier(
      workflows.filter(w => w.name.toLowerCase().endsWith(`-${lowerName}`)),
      'workflow.resolve_suffix_match'
    ) ??
    // Tier 4: Substring match (e.g. "smart" matches "archon-smart-pr-review")
    checkTier(
      workflows.filter(w => w.name.toLowerCase().includes(lowerName)),
      'workflow.resolve_substring_match'
    )
  );
}
