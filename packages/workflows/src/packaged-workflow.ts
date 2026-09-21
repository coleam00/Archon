import { join } from 'path';
import type { WorkflowDefinition, WorkflowSource } from './schemas';
import {
  isAgentNode,
  isExecNode,
  isIncludeDirective,
  isLoopGroupNode,
  isLoopNode,
} from './schemas';
import { isValidCommandName } from './command-validation';

export const PACK_SHARED_DIRECTORY = '.shared';

const PACKAGED_RESOURCE_PREFIX = '__archon_pack__';
const OWNER_SEPARATOR = ':';
const RESOURCE_SEPARATOR = '::';

export interface WorkflowResourceOwner {
  source: WorkflowSource;
  pack: string;
  workflow: string;
}

export interface PackagedResourceReference {
  owner: WorkflowResourceOwner;
  name: string;
}

export function isValidWorkflowFolderSegment(segment: string): boolean {
  return (
    isValidCommandName(segment) &&
    !segment.includes(OWNER_SEPARATOR) &&
    !segment.includes(RESOURCE_SEPARATOR)
  );
}

export function formatPackagedResourceReference(
  owner: WorkflowResourceOwner,
  name: string
): string {
  if (
    !isValidWorkflowFolderSegment(owner.pack) ||
    !isValidWorkflowFolderSegment(owner.workflow) ||
    !isValidCommandName(name)
  ) {
    throw new Error(
      `Invalid packaged resource reference: ${owner.source}:${owner.pack}:${owner.workflow}::${name}`
    );
  }
  return `${PACKAGED_RESOURCE_PREFIX}${owner.source}${OWNER_SEPARATOR}${owner.pack}${OWNER_SEPARATOR}${owner.workflow}${RESOURCE_SEPARATOR}${name}`;
}

export function parsePackagedResourceReference(
  reference: string
): PackagedResourceReference | null {
  if (!reference.startsWith(PACKAGED_RESOURCE_PREFIX)) return null;
  const resourceMarker = reference.indexOf(RESOURCE_SEPARATOR, PACKAGED_RESOURCE_PREFIX.length);
  if (resourceMarker < 0) return null;

  const ownerParts = reference
    .slice(PACKAGED_RESOURCE_PREFIX.length, resourceMarker)
    .split(OWNER_SEPARATOR);
  if (ownerParts.length !== 3) return null;
  const [source, pack, workflow] = ownerParts;
  const name = reference.slice(resourceMarker + RESOURCE_SEPARATOR.length);
  if (
    (source !== 'bundled' && source !== 'global' && source !== 'project') ||
    !isValidWorkflowFolderSegment(pack) ||
    !isValidWorkflowFolderSegment(workflow) ||
    !isValidCommandName(name)
  ) {
    return null;
  }
  return { owner: { source, pack, workflow }, name };
}

export function getPackagedWorkflowPath(
  workflowsRoot: string,
  owner: Pick<WorkflowResourceOwner, 'pack' | 'workflow'>
): string {
  return join(workflowsRoot, owner.pack, owner.workflow);
}

export function getPackagedResourceDirectory(
  workflowsRoot: string,
  owner: Pick<WorkflowResourceOwner, 'pack' | 'workflow'>,
  kind: 'commands' | 'scripts'
): string {
  return join(getPackagedWorkflowPath(workflowsRoot, owner), kind);
}

function isNamedScript(script: string): boolean {
  return !script.includes('\n') && !/[;(){}&|<>$`"' ]/.test(script);
}

function qualifyResourceReference(reference: string, owner: WorkflowResourceOwner): string {
  if (parsePackagedResourceReference(reference) !== null) return reference;
  return formatPackagedResourceReference(owner, reference);
}

function qualifyNodeResources(
  node: WorkflowDefinition['nodes'][number],
  owner: WorkflowResourceOwner
): void {
  // An include directive carries no resources of its own to qualify here (matches
  // prior behavior — it fell through every check unmutated before #2486 too).
  if (isIncludeDirective(node)) return;
  if (isAgentNode(node) && node.source.kind === 'command') {
    node.source.name = qualifyResourceReference(node.source.name, owner);
  }
  if (isExecNode(node) && node.runtime !== 'sh' && isNamedScript(node.script)) {
    node.script = qualifyResourceReference(node.script, owner);
  }
  if (isLoopNode(node) && node.loop.command !== undefined) {
    node.loop.command = qualifyResourceReference(node.loop.command, owner);
  }
  if (isLoopGroupNode(node)) {
    for (const child of node.loop_group.nodes) qualifyNodeResources(child, owner);
  }
}

export function qualifyWorkflowResources(
  workflow: WorkflowDefinition,
  owner: WorkflowResourceOwner
): WorkflowDefinition {
  for (const node of workflow.nodes) qualifyNodeResources(node, owner);
  return workflow;
}
