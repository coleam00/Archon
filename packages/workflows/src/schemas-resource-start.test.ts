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

describe('resource start receipt origin in run metadata', () => {
  test('a written origin reads back its receipt; a malformed one reads as no receipt', async () => {
    const { RESOURCE_START_METADATA_KEY, readResourceStartReceiptId } = await import(
      './schemas/resource-start'
    );
    const receiptId = '0b6f3c1e-4a5d-4f6e-9a7b-1c2d3e4f5a6b';
    const read = (origin: unknown): string | undefined =>
      readResourceStartReceiptId({ [RESOURCE_START_METADATA_KEY]: origin });

    expect(read({ receiptId, bindingId: 'deploy' })).toBe(receiptId);
    expect(readResourceStartReceiptId(undefined)).toBeUndefined();
    for (const malformed of [
      null,
      'text',
      [receiptId],
      { bindingId: 'deploy' },
      { receiptId: 7, bindingId: 'deploy' },
      { receiptId: 'not-a-uuid', bindingId: 'deploy' },
    ])
      expect(read(malformed)).toBeUndefined();
  });
});

describe('persisted records a newer binary may have written', () => {
  test('read with a field this binary does not know; a missing field still refuses', async () => {
    const {
      CHECKOUT_HANDOFF_METADATA_KEY,
      readAsksCheckout,
      readCheckoutHandoff,
      readResourceStartOrigin,
    } = await import('./schemas/resource-start');
    const { readOwnedWorktree } = await import('./schemas/run-metadata');
    const uuid = '0b6f3c1e-4a5d-4f6e-9a7b-1c2d3e4f5a6b';
    const handoff = { runId: 'run', branch: 'main', commit: 'a'.repeat(40) };
    const later = { later: 1 };
    const handoffMetadata = { ...handoff, lane: 'continue' as const };
    const run = (value: unknown) => ({
      id: 'run',
      metadata: { [CHECKOUT_HANDOFF_METADATA_KEY]: value },
    });

    expect(readCheckoutHandoff(run({ ...handoffMetadata, ...later }))).toEqual(handoffMetadata);
    expect(
      readAsksCheckout({
        id: 'run',
        metadata: {
          asks_checkout: { handoff: { ...handoff, ...later }, worktree: '/w', ...later },
        },
      })
    ).toEqual({ handoff, worktree: '/w' });
    expect(
      readResourceStartOrigin({ resource_start: { receiptId: uuid, bindingId: 'b', ...later } })
    ).toEqual({
      receiptId: uuid,
      bindingId: 'b',
    });
    expect(
      readOwnedWorktree({ owned_worktree: { envId: 'e', creationId: uuid, ...later } })
    ).toEqual({
      envId: 'e',
      creationId: uuid,
    });

    const { commit: _, ...missingCommit } = handoffMetadata;
    expect(() => readCheckoutHandoff(run(missingCommit))).toThrow(
      `invalid ${CHECKOUT_HANDOFF_METADATA_KEY}`
    );
  });

  test('a record that mixes two variants is wrong, not newer', async () => {
    const { readAsksCheckout } = await import('./schemas/resource-start');
    const handoff = { runId: 'run', branch: 'main', commit: 'a'.repeat(40) };
    expect(
      readAsksCheckout({
        id: 'run',
        metadata: { asks_checkout: { handoff, worktree: '/w', refused: 'gone' } },
      })
    ).toEqual({ refused: 'gone' });
    // A refusal key with no valid reason is an invalid record, never the hand-off beside it.
    for (const refused of ['', null, false])
      expect(
        readAsksCheckout({
          id: 'run',
          metadata: { asks_checkout: { handoff, worktree: '/w', refused } },
        })
      ).toEqual({ refused: "run 'run' has an invalid recorded asks_checkout" });
    const launch = (isolation: object) => ({
      version: 2,
      run: {
        id: crypto.randomUUID(),
        workflow_name: 'w',
        codebase_id: 'c',
        user_message: '',
        metadata: {},
      },
      execution: { cwd: '/project', conversationId: 'conversation', isolation },
    });
    expect(preparedWorkflowLaunchSchema.safeParse(launch({ kind: 'in-place' })).success).toBe(true);
    expect(
      preparedWorkflowLaunchSchema.safeParse(launch({ kind: 'in-place', branch: 'feature' }))
        .success
    ).toBe(false);
  });
});

describe('item mapping', () => {
  test('makes a key of text or a number and refuses any other value, naming the field', async () => {
    const { mappedItemKey } = await import('./schemas/resource-start');
    const mapping = { field: 'number', prefix: 'issue-' };
    expect(mappedItemKey(mapping, 42)).toEqual({ ok: true, key: 'issue-42' });
    expect(mappedItemKey({ field: 'id' }, 'abc')).toEqual({ ok: true, key: 'abc' });
    for (const [value, reason] of [
      [undefined, "field 'number' is missing"],
      ['', "field 'number' is empty"],
      [true, "field 'number' is not text or a number"],
      ['x'.repeat(200), "field 'number' makes an item key longer than 200 characters"],
    ] as const)
      expect(mappedItemKey(mapping, value)).toEqual({ ok: false, reason });
  });

  test("a run-ended or asks-settled file reads the item's answers; a linked one is refused", async () => {
    const { triggerConfigSchema } = await import('./schemas/resource-start');
    const file = (on: unknown) => ({
      version: 1,
      sourceInstanceId: 'source',
      binding: {
        bindingId: 'b',
        bindingRevision: null,
        hostId: 'h',
        runAsUserId: 'u',
        resource: 'r',
        overlap: 'queue',
        launch: { cwd: '/repo', workflowName: 'w', inputs: {}, isolation: { kind: 'default' } },
      },
      on,
    });
    const inputs = { decided: { item: 'answers' } };
    const runEnded = { workflowName: 'plan', outcome: 'done', inputs };
    for (const on of [
      { runEnded },
      { asksSettled: { workflowName: 'plan', settled: 'answered', inputs } },
    ])
      expect(triggerConfigSchema.safeParse(file(on)).success).toBe(true);
    const linked = triggerConfigSchema.safeParse(
      file({ runEnded: { ...runEnded, linked: { kind: 'part_of', holder: 'to' } } })
    );
    expect(linked.error?.issues.map(issue => issue.message)).toEqual([
      "A linked start is on a holder item, so it cannot read the item's answers; read them in the started stage",
    ]);
  });

  test('a trigger file reads a linked entry only beside linked.items', async () => {
    const { triggerConfigSchema } = await import('./schemas/resource-start');
    const file = (linked: unknown) => ({
      version: 1,
      sourceInstanceId: 'source',
      binding: {
        bindingId: 'b',
        bindingRevision: null,
        hostId: 'h',
        runAsUserId: 'u',
        resource: 'r',
        overlap: 'queue',
        launch: { cwd: '/repo', workflowName: 'w', inputs: {}, isolation: { kind: 'default' } },
      },
      on: {
        runEnded: {
          workflowName: 'split',
          outcome: 'split',
          linked,
          inputs: { brief: { entry: '/brief' } },
        },
      },
    });
    const named = { kind: 'part_of', holder: 'from', items: '/start' };
    expect(triggerConfigSchema.safeParse(file(named)).success).toBe(true);
    const unnamed = triggerConfigSchema.safeParse(file({ kind: 'part_of', holder: 'from' }));
    expect(unnamed.error?.issues.map(issue => issue.message)).toEqual([
      'An input reads { entry }, but only a linked start with linked.items has an entry per started item',
    ]);
  });

  test('a trigger file maps an item only when fire-only', async () => {
    const { triggerConfigSchema } = await import('./schemas/resource-start');
    const fireOnly = {
      version: 1,
      sourceInstanceId: 'source',
      binding: {
        bindingId: 'b',
        bindingRevision: null,
        hostId: 'h',
        runAsUserId: 'u',
        resource: 'r',
        overlap: 'queue',
        launch: { cwd: '/repo', workflowName: 'w', inputs: {}, isolation: { kind: 'default' } },
      },
      item: { field: 'number' },
    };
    expect(triggerConfigSchema.safeParse(fireOnly).success).toBe(true);
    const timer = triggerConfigSchema.safeParse({
      ...fireOnly,
      schedule: { intervalSeconds: 60, runAtLoad: false },
    });
    expect(timer.error?.issues.map(issue => issue.message)).toEqual([
      'A timer binding maps no item: a tick is about no item',
    ]);
  });
});

describe('a fire’s own choices for its starts', () => {
  test('a config path and model rebindings are the only things it may hold', async () => {
    const { startOverridesSchema } = await import('./schemas/resource-start');
    expect(
      startOverridesSchema.safeParse({
        config: { path: '/srv/archon/one-off.yaml' },
        models: { tiers: { large: 'pi/sonnet' }, aliases: { '@reviewer': 'pi/haiku' } },
      }).success
    ).toBe(true);
    // Either half alone, and models alone with no tier.
    expect(startOverridesSchema.safeParse({ config: { path: '/cfg.yaml' } }).success).toBe(true);
    expect(startOverridesSchema.safeParse({ models: { aliases: { '@a': 'pi/x' } } }).success).toBe(
      true
    );
    // A resolved profile is not what a start stores: the specs stay raw until preparation.
    expect(
      startOverridesSchema.safeParse({ models: { tiers: { large: { provider: 'pi' } } } }).success
    ).toBe(false);
    expect(startOverridesSchema.safeParse({ config: {} }).success).toBe(false);
    expect(startOverridesSchema.safeParse({ config: '/cfg.yaml' }).success).toBe(false);
    expect(startOverridesSchema.safeParse({ env: { A: '1' } }).success).toBe(false);
  });

  test('a binding carries them beside the intent fields a store keeps apart', async () => {
    const { resourceStartBindingIntentSchema } = await import('./schemas/resource-start');
    const intent = {
      bindingId: 'b',
      bindingRevision: null,
      hostId: 'h',
      runAsUserId: 'u',
      resource: 'r',
      overlap: 'queue',
      launch: { cwd: '/repo', workflowName: 'w', inputs: {}, isolation: { kind: 'default' } },
      startOverrides: { models: { tiers: { small: 'pi/haiku' } } },
    };
    expect(resourceStartBindingIntentSchema.safeParse(intent).success).toBe(true);
    expect(
      resourceStartBindingIntentSchema.safeParse({ ...intent, startOverrides: { config: {} } })
        .success
    ).toBe(false);
  });
});

describe('a binding file cannot choose its starts’ config', () => {
  test('a trigger file that carries startOverrides is refused', async () => {
    const { triggerConfigSchema } = await import('./schemas/resource-start');
    const file = {
      version: 1,
      sourceInstanceId: 'source',
      binding: {
        bindingId: 'b',
        bindingRevision: null,
        hostId: 'h',
        runAsUserId: 'u',
        resource: 'r',
        overlap: 'queue',
        launch: { cwd: '/repo', workflowName: 'w', inputs: {}, isolation: { kind: 'default' } },
      },
    };
    expect(triggerConfigSchema.safeParse(file).success).toBe(true);
    expect(
      triggerConfigSchema.safeParse({
        ...file,
        binding: { ...file.binding, startOverrides: { config: { path: '/cfg.yaml' } } },
      }).success
    ).toBe(false);
  });
});
