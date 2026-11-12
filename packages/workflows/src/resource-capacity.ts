import type { WorkflowResource } from './schemas/workflow';
import { resourceCapacitySchema } from './schemas/resource';
import type { PreparedWorkflowLaunch } from './schemas/resource-start';
import { readWorkflowSourceState } from './schemas/workflow-run';

export interface ResourceCapacityPolicy {
  loadCaps?: () => Promise<ReadonlyMap<string, number>>;
  readCapturedDeclaration?: (
    launch: PreparedWorkflowLaunch,
    resource: string
  ) => Promise<number | undefined>;
}

export function resolveResourceCapacity(
  caps: ReadonlyMap<string, number>,
  resource: string,
  declaration?: number
): number {
  return resourceCapacitySchema.parse(caps.get(resource) ?? declaration ?? 10);
}

export function selectStartResource(
  binding: { resource: string; capacity?: number },
  workflow?: WorkflowResource
): { resource: string; capacity?: number } {
  if (!workflow) return { resource: binding.resource, capacity: binding.capacity };
  const capacities = [
    workflow.capacity,
    ...(workflow.name === binding.resource ? [binding.capacity] : []),
  ].filter((value): value is number => value !== undefined);
  return {
    resource: workflow.name,
    capacity: capacities.length ? Math.min(...capacities) : undefined,
  };
}

export async function capturedResourceDeclaration(
  policy: ResourceCapacityPolicy,
  launch: PreparedWorkflowLaunch,
  resource: string
): Promise<number | undefined> {
  if (readWorkflowSourceState(launch.run.metadata).kind === 'absent') return undefined;
  if (!policy.readCapturedDeclaration)
    throw new Error(
      'Reading a legacy resource request with a captured source requires a captured declaration reader'
    );
  const declaration = await policy.readCapturedDeclaration(launch, resource);
  return declaration === undefined ? undefined : resourceCapacitySchema.parse(declaration);
}
