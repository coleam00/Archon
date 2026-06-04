/**
 * Validation orchestrator. Runs the instant tier (structural) and the
 * debounced tier (graph, content) and returns a deduped issue list.
 *
 * Client tiers only — there is no server-tier RPC in PR-1 (the `'server'` issue
 * source exists in the type but is unused here; it wires in PR-3). Issues are
 * deduped by their stable id (a hash of rule + path + message).
 */
import type { BuilderWorkflow, Issue } from '../types';
import { validateStructural } from './structural';
import { validateGraph } from './graph';
import { validateContent } from './content';

/** Run all client-tier validation rules and return the deduped issue list. */
export function runValidation(workflow: BuilderWorkflow): Issue[] {
  const all: Issue[] = [
    ...validateStructural(workflow),
    ...validateGraph(workflow),
    ...validateContent(workflow),
  ];

  const byId = new Map<string, Issue>();
  for (const issue of all) {
    if (!byId.has(issue.id)) byId.set(issue.id, issue);
  }
  return [...byId.values()];
}
