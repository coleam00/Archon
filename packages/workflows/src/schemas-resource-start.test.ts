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

import { z } from 'zod';
import {
  ADMISSION_CHECKOUT_GUARD_METADATA_KEY,
  preparedWorkflowLaunchSchema,
  readAdmissionCheckoutGuard,
} from './schemas/resource-start';
import { jsonValueSchema } from './output-ref';

describe('prepared checkout guard declaration', () => {
  const launch = {
    version: 2,
    run: {
      id: crypto.randomUUID(),
      workflow_name: 'test',
      codebase_id: 'codebase',
      user_message: '',
      metadata: { source: { anchor: 'saved' }, inputs: { name: 'value' } },
    },
    execution: { cwd: '/project', conversationId: 'conversation', isolation: { kind: 'in-place' } },
  };
  for (const value of [true, false, undefined, null, 'false', 0]) {
    test(`reads ${String(value)} without weakening legacy declarations`, () => {
      const prepared = preparedWorkflowLaunchSchema.parse({
        ...launch,
        run: {
          ...launch.run,
          metadata: {
            ...launch.run.metadata,
            ...(value === undefined ? {} : { [ADMISSION_CHECKOUT_GUARD_METADATA_KEY]: value }),
          },
        },
      });
      if (typeof value !== 'boolean' && value !== undefined)
        expect(() => readAdmissionCheckoutGuard(prepared)).toThrow('expected a boolean');
      else expect(readAdmissionCheckoutGuard(prepared)).toBe(value ?? true);
    });
  }
  test('upgrades shipped v1 and v2 launches without rewriting their metadata', () => {
    for (const stored of [
      launch,
      {
        ...launch,
        version: 1,
        run: {
          ...launch.run,
          conversation_id: 'conversation',
          user_id: 'operator',
        },
      },
    ]) {
      const prepared = preparedWorkflowLaunchSchema.parse(stored);
      expect(readAdmissionCheckoutGuard(prepared)).toBe(true);
      expect(prepared.run.metadata).toEqual(launch.run.metadata);
    }
  });
  test('the shipped strict v2 envelope accepts and preserves the additive metadata key', () => {
    // Historical reader fixture: changing this would stop proving rollback compatibility.
    const shippedV2 = z
      .object({
        version: z.literal(2),
        run: z
          .object({
            id: z.string().uuid(),
            workflow_name: z.string().min(1),
            codebase_id: z.string().min(1),
            user_message: z.string(),
            metadata: z.record(z.string(), jsonValueSchema),
            working_path: z.string().min(1).optional(),
            origin: z
              .object({
                conversationId: z.string().optional(),
                parentConversationId: z.string().optional(),
                userId: z.string().optional(),
              })
              .strict()
              .optional(),
          })
          .strict(),
        execution: z
          .object({
            cwd: z.string().min(1),
            conversationId: z.string().min(1),
            isolation: z.discriminatedUnion('kind', [
              z.object({ kind: z.literal('in-place') }).strict(),
              z
                .object({
                  kind: z.literal('worktree'),
                  branch: z.string().min(1).optional(),
                  fromBranch: z.string().min(1).optional(),
                  baseOverride: z.string().min(1).optional(),
                })
                .strict(),
            ]),
          })
          .strict(),
      })
      .strict();
    const current = preparedWorkflowLaunchSchema.parse({
      ...launch,
      run: {
        ...launch.run,
        metadata: { ...launch.run.metadata, [ADMISSION_CHECKOUT_GUARD_METADATA_KEY]: false },
      },
    });
    expect(shippedV2.parse(current)).toEqual(current);
  });
});
