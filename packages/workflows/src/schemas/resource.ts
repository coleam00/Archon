import { z } from 'zod';

/**
 * Resource keys under this prefix are provider-attempt slots owned by core provider
 * admission. An operator-named resource cannot use it, so a trigger resource never
 * shares a slot, or its capacity, with a provider cap.
 */
export const PROVIDER_RESOURCE_PREFIX = 'provider:';

const notProviderResource = {
  check: (name: string): boolean => !name.startsWith(PROVIDER_RESOURCE_PREFIX),
  message: `Resource names starting with '${PROVIDER_RESOURCE_PREFIX}' are reserved for provider admission`,
};

export const resourceNameSchema = z
  .string()
  .min(1)
  .refine(notProviderResource.check, notProviderResource.message);

export const resourceCapacitySchema = z.number().int().positive();
