/**
 * The `display` issues `archon validate` adds to each workflow's result: what a workflow's own
 * display declarations get wrong, and, from `validate.ts`, what a pack's stages leave a reader
 * without (`packDisplayIssues`).
 */
import { displayDeclarationFindings } from '@archon/workflows/display-declarations';
import type { WorkflowWithSource } from '@archon/workflows/schemas/workflow';
import { makeWorkflowResult } from '@archon/workflows/validator';
import type { ValidationIssue, WorkflowValidationResult } from '@archon/workflows/validator';

/**
 * Each workflow's display declarations a reader counts with and cannot read, as errors by the
 * workflow's name: a mark's unknown `means`, a `results` pointer its result does not declare
 * (`display-declarations.ts`). Checked on the flattened workflow discovery returns.
 */
export function displayDeclarationIssues(
  entries: readonly WorkflowWithSource[]
): Map<string, ValidationIssue[]> {
  const byWorkflow = new Map<string, ValidationIssue[]>();
  for (const { workflow } of entries) {
    const issues = displayDeclarationFindings(workflow).map(
      ({ message, hint }): ValidationIssue => ({ level: 'error', field: 'display', message, hint })
    );
    if (issues.length > 0) byWorkflow.set(workflow.name, issues);
  }
  return byWorkflow;
}

/**
 * `results` with each stage's display issues added to its workflow's own result, so a stage
 * reads as one entry. A stage with no result of its own gets one, unless `name` filters it out.
 */
export function withDisplayIssues(
  results: WorkflowValidationResult[],
  byStage: ReadonlyMap<string, ValidationIssue[]>,
  name: string | undefined
): WorkflowValidationResult[] {
  const merged = results.map(result => {
    const issues = byStage.get(result.workflowName);
    return issues === undefined
      ? result
      : makeWorkflowResult(result.workflowName, [...result.issues, ...issues], result.filename);
  });
  for (const [stage, issues] of byStage)
    if (
      !results.some(result => result.workflowName === stage) &&
      (name === undefined || name === stage)
    )
      merged.push(makeWorkflowResult(stage, issues));
  return merged;
}
