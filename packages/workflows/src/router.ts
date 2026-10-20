/**
 * Workflow name lookup and resolution
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
 * 3. Suffix match (e.g. "review" → "archon-review")
 * 4. Substring match (e.g. "vestig" → "archon-investigate")
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
    // Tier 3: Suffix match (e.g. "review" matches "archon-review")
    checkTier(
      workflows.filter(w => w.name.toLowerCase().endsWith(`-${lowerName}`)),
      'workflow.resolve_suffix_match'
    ) ??
    // Tier 4: Substring match (e.g. "vestig" matches "archon-investigate")
    checkTier(
      workflows.filter(w => w.name.toLowerCase().includes(lowerName)),
      'workflow.resolve_substring_match'
    )
  );
}
