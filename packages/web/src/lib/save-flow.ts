/**
 * Pure save flow for the studio-backed builder route. Given a store snapshot,
 * runs `toWorkflowDefinition → schema parse → client.validateWorkflow → client.saveWorkflow`
 * and returns a discriminated result so the caller can drive UI banners.
 *
 * No React, no DOM. Lives in `src/lib/` so the no-preload test batch picks it
 * up. The companion test stubs `WorkflowApiClient` directly (no `mock.module`).
 */
import {
  toWorkflowDefinition,
  workflowDefinitionSchema,
  type LoadWorkflowInput,
  type WorkflowApiClient,
  type WorkflowDefinition,
} from '@archon/workflow-studio-core';

export type SaveResult =
  | { kind: 'saved'; name: string }
  | { kind: 'invalid'; errors: string[] }
  | { kind: 'failed'; error: Error };

export async function runSaveFlow(
  client: WorkflowApiClient,
  cwd: string,
  snapshot: LoadWorkflowInput
): Promise<SaveResult> {
  const trimmedName = snapshot.meta.name.trim();
  if (trimmedName === '') {
    return { kind: 'invalid', errors: ['Workflow name is required'] };
  }

  const rawDefinition = toWorkflowDefinition(snapshot);
  const parsed = workflowDefinitionSchema.safeParse(rawDefinition);
  if (!parsed.success) {
    return {
      kind: 'invalid',
      errors: parsed.error.issues.map(i => i.message),
    };
  }

  const definition = parsed.data as WorkflowDefinition;

  try {
    const result = await client.validateWorkflow(definition);
    if (!result.valid) {
      return {
        kind: 'invalid',
        errors: result.errors ?? ['Unknown validation error'],
      };
    }

    await client.saveWorkflow(trimmedName, cwd, definition);
    return { kind: 'saved', name: trimmedName };
  } catch (error) {
    return {
      kind: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
