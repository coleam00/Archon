// @archon-test-isolated
import { describe, test, expect } from 'bun:test';

describe('resource start resource names', () => {
  test('the provider admission namespace is reserved', async () => {
    const {
      PROVIDER_RESOURCE_PREFIX,
      resourceStartIntentSchema,
      resourceStartBindingIntentSchema,
    } = await import('./schemas/resource-start');
    const reserved = `${PROVIDER_RESOURCE_PREFIX}claude`;
    for (const schema of [
      resourceStartIntentSchema.shape.resource,
      resourceStartBindingIntentSchema.shape.resource,
    ]) {
      expect(schema.safeParse(reserved).success).toBe(false);
      expect(schema.safeParse('deploy-lane').success).toBe(true);
    }
  });
});
