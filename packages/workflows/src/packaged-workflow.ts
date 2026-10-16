import type { WorkflowDefinition, WorkflowSource } from './schemas';
import {
  isAgentNode,
  isComposeFanOutNode,
  isExecNode,
  isIncludeDirective,
  isLoopGroupNode,
  isLoopNode,
  isWorkflowNode,
} from './schemas';
import { workflowSourceSchema } from './schemas/workflow';
import { isValidCommandName } from './command-validation';
import { resolveWorkflowName } from './router';

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
  const parsedSource = workflowSourceSchema.safeParse(source);
  if (
    !parsedSource.success ||
    !isValidWorkflowFolderSegment(pack) ||
    !isValidWorkflowFolderSegment(workflow) ||
    !isValidCommandName(name)
  ) {
    return null;
  }
  return { owner: { source: parsedSource.data, pack, workflow }, name };
}

/**
 * A resource name without its package owner. Discovery qualifies a pack's commands with the
 * owner it was found under; the owner is not part of what runs, so display and telemetry
 * name the bare resource. Unqualified names pass through unchanged.
 */
export function unqualifiedResourceName(reference: string): string {
  return parsePackagedResourceReference(reference)?.name ?? reference;
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

/**
 * Rewrite an installed pack workflow's references to workflows of the same pack from
 * their authored `name:` to their qualified discovery identity: `include:` targets
 * (a fan-out's too) and `workflow:` targets. Public identities take precedence over
 * authored aliases, including other packs' entrypoints and targets that failed to load.
 * Cross-pack includes still fail in the pack's own name map; child runs resolve
 * through the catalog.
 *
 * Reports ambiguous authored references and `workflow:` targets that name support
 * workflows. A child run is dispatch; support workflows compose through `include:` only.
 */
export function qualifyPackReferences(
  workflow: WorkflowDefinition,
  qualifiedByName: ReadonlyMap<string, readonly string[]>,
  entrypoints: ReadonlySet<string>,
  publicNames: ReadonlySet<string>
): { supportChildren: string[]; ambiguousReferences: string[] } {
  const supportChildren: string[] = [];
  const ambiguousReferences = new Set<string>();
  const publicWorkflows = [...publicNames].map(name => ({ name }));
  const resolve = (name: string): string | undefined => {
    if (name.includes(':')) {
      return resolveWorkflowName(name, publicWorkflows)?.name;
    }
    const targets = qualifiedByName.get(name);
    if (targets !== undefined && targets.length > 1) {
      ambiguousReferences.add(name);
      return undefined;
    }
    return targets?.[0];
  };
  const visit = (nodes: WorkflowDefinition['nodes']): void => {
    for (const node of nodes) {
      if (isIncludeDirective(node) || isComposeFanOutNode(node)) {
        node.include = resolve(node.include) ?? node.include;
        continue;
      }
      if (isWorkflowNode(node)) {
        const target = resolve(node.workflow);
        if (target !== undefined && !entrypoints.has(target)) supportChildren.push(node.workflow);
        else if (target !== undefined) node.workflow = target;
      }
      if (isLoopGroupNode(node)) visit(node.loop_group.nodes);
    }
  };
  visit(workflow.nodes);
  return { supportChildren, ambiguousReferences: [...ambiguousReferences] };
}
