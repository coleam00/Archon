/**
 * A fresh run's checks against an explicit `--workflow-source`, and the report of which
 * pack copy it reads. Every refusal names what the source directory was read as.
 */
import { resolve } from 'node:path';
import { checkoutRootAbove } from '@archon/core/workflows/binding-workflow';
import type {
  ResolvedWorkflow,
  WorkflowSource,
  WorkflowWithSource,
} from '@archon/workflows/schemas/workflow';
import { describeWorkflowSource, packCopyLines } from './pack-copies';

/** What these checks read of a run request. */
interface SourceCheckRequest {
  readonly cwd: string;
  readonly workflowName: string;
  readonly options: {
    readonly discoveryCwd?: string;
    readonly json?: boolean;
    readonly quiet?: boolean;
  };
}

/**
 * A fresh run's checks against the source it named, then the report of which pack copy it
 * reads. An explicit --workflow-source that lacks the named workflow would otherwise run
 * another scope's copy while recording the source as its origin (#5826). Commands, scripts
 * and composed workflows may still resolve from other scopes; the named workflow may not.
 */
export async function admitFromSource(
  request: SourceCheckRequest,
  workflow: ResolvedWorkflow,
  workflowEntry: WorkflowWithSource | undefined,
  workflowEntries: readonly WorkflowWithSource[]
): Promise<void> {
  const { cwd, workflowName, options } = request;
  if (options.discoveryCwd !== undefined && workflowEntry?.source !== 'project') {
    throw await workflowNotInSourceError(
      workflowName,
      options.discoveryCwd,
      workflowEntry?.source,
      workflowEntries
    );
  }
  // Which copy of the workflow's pack this run reads, from its live origin. Under --json
  // it goes to stderr, as parse warnings do, so an agent reading stdout gets only the payload.
  if (options.quiet && !options.json) return;
  const print = options.json ? console.error : console.log;
  const lines = await packCopyLines(
    workflow,
    workflowEntries,
    options.discoveryCwd ?? cwd,
    options.discoveryCwd !== undefined
  );
  for (const line of lines) print(line);
}

async function workflowNotInSourceError(
  workflowName: string,
  sourceRoot: string,
  resolvedScope: WorkflowSource | undefined,
  workflowEntries: readonly WorkflowWithSource[]
): Promise<Error> {
  const root = resolve(sourceRoot);
  const lines = [
    `Workflow '${workflowName}' is not in --workflow-source ${root}; Archon found it only in ` +
      `the ${resolvedScope ?? 'another'} scope. Nothing was started.`,
    `--workflow-source ${root}: ${await describeWorkflowSource(root, workflowEntries)}.`,
    ...checkoutRootHint(root),
  ];
  return new Error(lines.join('\n'));
}

/**
 * Every refusal under an explicit --workflow-source names what the directory was read as,
 * so a wrong path or a wrong name is visible whether or not the name exists in another scope.
 */
export async function withSourceContext(
  error: Error,
  sourceRoot: string | undefined,
  workflowEntries: readonly WorkflowWithSource[]
): Promise<Error> {
  if (sourceRoot === undefined) return error;
  const root = resolve(sourceRoot);
  const lines = [
    error.message,
    '',
    `--workflow-source ${root}: ${await describeWorkflowSource(root, workflowEntries)}.`,
    ...checkoutRootHint(root),
  ];
  return new Error(lines.join('\n'));
}

function checkoutRootHint(root: string): string[] {
  const checkout = checkoutRootAbove(root);
  return checkout === undefined
    ? []
    : [`--workflow-source takes the checkout root; did you mean ${checkout}?`];
}
