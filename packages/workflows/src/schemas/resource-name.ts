import { z } from 'zod';

/**
 * Resource keys under this prefix are provider-attempt slots owned by core provider
 * admission. An operator-named resource cannot use it, so a trigger resource never
 * shares a slot, or its capacity, with a provider cap.
 */
export const PROVIDER_RESOURCE_PREFIX = 'provider:';

export const notProviderResource = {
  check: (name: string): boolean => !name.startsWith(PROVIDER_RESOURCE_PREFIX),
  message: `Resource names starting with '${PROVIDER_RESOURCE_PREFIX}' are reserved for provider admission`,
};

/** The capacity of a resource that no start, binding or install config gave a number. */
export const DEFAULT_RESOURCE_CAPACITY = 1;

/** A capacity a start declares: a workflow's `resource.capacity` or a binding's `capacity`. */
export const declaredCapacitySchema = z.number().int().min(1);

/** A resource name a binding or a workflow's `resource:` names. */
export const resourceNameSchema = z
  .string()
  .trim()
  .min(1)
  .refine(notProviderResource.check, notProviderResource.message);

/**
 * A workflow's `resource:`, as the loader normalizes it: `resource: build` is
 * `{ name: 'build' }`. `capacity` is the number this workflow's hand starts declare, and
 * its binding starts when the binding sets none; omitted, they declare the default.
 */
export const workflowResourceSchema = z
  .object({ name: resourceNameSchema, capacity: declaredCapacitySchema.optional() })
  .strict();
export type WorkflowResource = z.infer<typeof workflowResourceSchema>;
