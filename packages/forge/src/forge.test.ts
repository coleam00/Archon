import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  createForgeInputBindingSchema,
  createForgeBindingSchema,
  forgeEventEnvelopeSchema,
  mapForgeInputs,
  matchForgeEvent,
} from './index';

describe('authored forge bindings', () => {
  const parsed = forgeEventEnvelopeSchema.parse({
    schemaVersion: 1,
    sourceInstanceId: 'github-primary',
    deliveryId: 'd',
    contentDigest: 'digest',
    receivedAt: '2026-09-22T10:00:01Z',
    occurredAt: null,
    event: {
      kind: 'pr.lifecycle',
      action: 'opened',
      pr: { repo: { host: 'github.com', path: 'org/repo' }, number: 9 },
      state: 'open',
      draft: false,
      head: { objectId: 'opaque', branch: 'feature' },
      base: { objectId: 'base', branch: 'dev' },
    },
  });

  test('matches exact identity and variant predicates', () => {
    expect(
      matchForgeEvent(
        {
          kind: 'pr.lifecycle',
          actions: ['opened'],
          repository: { host: 'github.com', path: 'org/repo' },
          subject: { kind: 'pr', number: 9 },
          predicates: [{ field: 'pr.base.branch', equals: 'dev' }],
        },
        parsed.event
      )
    ).toBe(true);
    expect(
      matchForgeEvent(
        {
          kind: 'pr.lifecycle',
          actions: ['opened'],
          repository: { host: 'github.com', path: 'other' },
        },
        parsed.event
      )
    ).toBe(false);
  });

  test('maps typed literals and direct fields and rejects missing facts', () => {
    const bindingSchema = createForgeInputBindingSchema(
      z.union([z.string(), z.number(), z.boolean(), z.null()])
    );
    const mapping = {
      attempts: bindingSchema.parse({ source: 'literal', value: 3 }),
      pr: bindingSchema.parse({ source: 'field', field: 'subject.number' }),
    };
    expect(mapForgeInputs(mapping, parsed.event)).toEqual({
      ok: true,
      inputs: { attempts: 3, pr: 9 },
    });
    expect(
      mapForgeInputs(
        { result: bindingSchema.parse({ source: 'field', field: 'check.result' }) },
        parsed.event
      )
    ).toEqual({
      ok: false,
      input: 'result',
      field: 'check.result',
      reason: 'Required event field check.result is unavailable',
    });
  });

  test('rejects selector and input fields that cannot exist on the selected variant', () => {
    const bindingSchema = createForgeBindingSchema(
      z.union([z.string(), z.number(), z.boolean(), z.null()])
    );
    expect(() =>
      bindingSchema.parse({
        selector: {
          kind: 'issue.lifecycle',
          actions: ['merged'],
          predicates: [{ field: 'check.result', equals: 'success' }],
        },
        inputs: { result: { source: 'field', field: 'check.result' } },
      })
    ).toThrow();
    expect(() =>
      bindingSchema.parse({
        selector: { kind: 'check.changed', actions: ['changed'] },
        inputs: { result: { source: 'field', field: 'check.result' } },
      })
    ).not.toThrow();
  });
});
