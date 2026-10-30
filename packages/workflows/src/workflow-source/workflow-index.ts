import { basename, join, resolve } from 'node:path';
import { getWorkflowFolderSearchPaths } from '@archon/paths';
import { walkStaticNodes } from '../include/static-nodes';
import { isWorkflowNode, type WorkflowDefinition } from '../schemas';
import {
  loadScopeDirectory,
  loadPackWorkflows,
  type ParsedWorkflowFile,
  type WorkflowParseContext,
} from '../workflow-discovery/load-dir';
import { BUNDLED_SCOPE_DIR, PROJECT_SCOPE_DIR, isInstalledSourceUnit } from './roots';
import type { SourceUnit } from './unit-index';

async function admittedWorkflows(
  unit: SourceUnit,
  unitRoot: string,
  context: WorkflowParseContext
): Promise<ParsedWorkflowFile[]> {
  if (isInstalledSourceUnit(unit.root)) {
    const loaded = await loadPackWorkflows(
      { ...context, pack: basename(unit.root), source: 'installed', label: unit.root },
      unitRoot
    );
    const readError = loaded.errors.find(error => error.errorType === 'read_error');
    if (readError) throw readError.cause ?? new Error(readError.error);
    return loaded.files.map(file => file.parsed);
  }
  const scope =
    unit.root === PROJECT_SCOPE_DIR
      ? 'project'
      : unit.root === BUNDLED_SCOPE_DIR
        ? 'bundled'
        : 'global';
  const directory = scope === 'project' ? getWorkflowFolderSearchPaths()[0] : 'workflows';
  const loaded = await loadScopeDirectory(
    context,
    join(unitRoot, directory, ...(scope === 'bundled' ? ['defaults'] : [])),
    join(unitRoot, directory),
    scope
  );
  const readError = loaded.errors.find(error => error.errorType === 'read_error');
  if (readError) throw readError.cause ?? new Error(readError.error);
  return [...loaded.workflows.values()];
}

function workflowIdentity(
  workflow: WorkflowDefinition
): NonNullable<SourceUnit['files'][number]['workflow']> {
  const references = new Set<string>();
  for (const edge of walkStaticNodes(workflow.nodes)) {
    if (edge.kind === 'include') references.add(edge.node.include);
    else if (edge.kind === 'executable' && isWorkflowNode(edge.node))
      references.add(edge.node.workflow);
  }
  return { name: workflow.name, references: [...references] };
}

export async function indexWorkflowFiles(
  root: string,
  units: SourceUnit[],
  context: WorkflowParseContext
): Promise<void> {
  for (const unit of units) {
    const unitRoot = resolve(root, unit.root);
    const admitted = await admittedWorkflows(unit, unitRoot, context);
    const workflows = new Map(admitted.map(parsed => [parsed.filePath, parsed.workflow]));
    for (const file of unit.files) {
      const workflow = workflows.get(resolve(unitRoot, file.path));
      if (workflow !== undefined) file.workflow = workflowIdentity(workflow);
    }
  }
}
