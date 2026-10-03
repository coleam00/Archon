/**
 * Workflow Router - detects workflow invocation and resolves workflow names
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
export function findWorkflow<T extends Pick<WorkflowDefinition, 'name'>>(
  name: string,
  workflows: readonly T[]
): T | undefined {
  return workflows.find(w => w.name === name);
}

/**
 * Resolve a workflow by name using a 4-tier fallback hierarchy:
 * 1. Exact match
 * 2. Case-insensitive match
 * 3. Suffix match (e.g. "assist" → "archon-assist")
 * 4. Substring match (e.g. "smart" → "archon-smart-pr-review")
 *
 * A qualified installed name (`owner/plugin:entrypoint`) stops after tier 2.
 *
 * Returns the matched workflow, or undefined if no match found.
 * Throws an Error if multiple workflows match at the same tier (ambiguous).
 */
export function resolveWorkflowName<T extends Pick<WorkflowDefinition, 'name'>>(
  name: string,
  workflows: readonly T[]
): T | undefined {
  // Tier 1: Exact match
  const exact = workflows.find(w => w.name === name);
  if (exact) return exact;

  const lowerName = name.toLowerCase();

  // Returns the single match, throws on ambiguity, returns undefined for no match
  function checkTier(matches: T[], logEvent: string): T | undefined {
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

  const caseInsensitive = checkTier(
    workflows.filter(w => w.name.toLowerCase() === lowerName),
    'workflow.resolve_case_insensitive_match'
  );
  // A qualified installed name (`owner/plugin:entrypoint`) names exactly one workflow.
  // When that plugin is missing or the name is a support workflow, the suffix and
  // substring tiers would otherwise resolve it to another pack's longer name or to a
  // copied project workflow.
  if (name.includes(':')) return caseInsensitive;

  return (
    // Tier 2: Case-insensitive match
    caseInsensitive ??
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
