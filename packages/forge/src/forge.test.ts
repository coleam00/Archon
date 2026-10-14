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

  test('maps who changed a label and who wrote a comment', () => {
    const bindingSchema = createForgeInputBindingSchema(z.string());
    const subject = {
      kind: 'issue',
      ref: { repo: { host: 'github.com', path: 'org/repo' }, number: 7 },
    } as const;
    const octo = { host: 'github.com', id: '42', login: 'octo' };
    const field = (name: string) => bindingSchema.parse({ source: 'field', field: name });
    const labelled = {
      kind: 'label.changed',
      action: 'added',
      subject,
      label: { name: 'archon-triage', id: null },
      actor: octo,
    } as const;
    expect(
      mapForgeInputs({ id: field('label.actor.id'), login: field('label.actor.login') }, labelled)
    ).toEqual({ ok: true, inputs: { id: '42', login: 'octo' } });
    expect(
      mapForgeInputs({ id: field('label.actor.id') }, { ...labelled, actor: null })
    ).toMatchObject({ ok: false, field: 'label.actor.id' });
    const commented = {
      kind: 'comment.changed',
      action: 'created',
      subject,
      comment: { id: '900', author: octo },
    } as const;
    expect(
      matchForgeEvent(
        { kind: 'comment.changed', actions: ['created'], subject: { kind: 'issue', number: 7 } },
        commented
      )
    ).toBe(true);
    expect(
      mapForgeInputs(
        {
          number: field('subject.number'),
          comment: field('comment.id'),
          author: field('comment.author.login'),
        },
        commented
      )
    ).toEqual({ ok: true, inputs: { number: 7, comment: '900', author: 'octo' } });
    expect(() =>
      createForgeBindingSchema(z.string()).parse({
        selector: { kind: 'comment.changed', actions: ['created'] },
        inputs: { actor: { source: 'field', field: 'label.actor.login' } },
      })
    ).toThrow();
  });
});
