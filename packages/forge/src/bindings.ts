import { z } from 'zod';
import {
  checkResultSchema,
  commentChangedEventSchema,
  issueLifecycleEventSchema,
  labelChangedEventSchema,
  prLifecycleEventSchema,
  type ForgeEvent,
} from './events';
import { repoRefSchema, type RepoRef } from './identity';

type ForgeFieldValue = string | number | boolean;

export const forgeEventFieldSchema = z.enum([
  'event.kind',
  'event.action',
  'repository.host',
  'repository.path',
  'subject.kind',
  'subject.number',
  'issue.state',
  'pr.state',
  'pr.draft',
  'pr.head.objectId',
  'pr.head.branch',
  'pr.base.objectId',
  'pr.base.branch',
  'label.name',
  'label.id',
  'label.actor.id',
  'label.actor.login',
  'comment.id',
  'comment.author.id',
  'comment.author.login',
  'check.revision',
  'check.unit.kind',
  'check.unit.id',
  'check.unit.name',
  'check.nativeState',
  'check.nativeResult',
  'check.phase',
  'check.result',
]);
export type ForgeEventField = z.infer<typeof forgeEventFieldSchema>;

const predicateSchema = z.union([
  z
    .object({
      field: z.literal('label.name'),
      equals: z.string().min(1).optional(),
      in: z.array(z.string().min(1)).min(1).optional(),
    })
    .refine(value => (value.equals === undefined) !== (value.in === undefined)),
  z
    .object({
      field: z.literal('pr.base.branch'),
      equals: z.string().min(1).optional(),
      in: z.array(z.string().min(1)).min(1).optional(),
    })
    .refine(value => (value.equals === undefined) !== (value.in === undefined)),
  z
    .object({
      field: z.literal('check.result'),
      equals: checkResultSchema.optional(),
      in: z.array(checkResultSchema).min(1).optional(),
    })
    .refine(value => (value.equals === undefined) !== (value.in === undefined)),
  z
    .object({
      field: z.literal('check.phase'),
      equals: z.enum(['pending', 'running', 'completed', 'unknown']).optional(),
      in: z
        .array(z.enum(['pending', 'running', 'completed', 'unknown']))
        .min(1)
        .optional(),
    })
    .refine(value => (value.equals === undefined) !== (value.in === undefined)),
  z
    .object({
      field: z.literal('check.unit.kind'),
      equals: z.enum(['check', 'commit_status']).optional(),
      in: z
        .array(z.enum(['check', 'commit_status']))
        .min(1)
        .optional(),
    })
    .refine(value => (value.equals === undefined) !== (value.in === undefined)),
]);

const selectorIdentitySchema = z.object({
  repository: repoRefSchema.optional(),
  subject: z
    .object({ kind: z.enum(['issue', 'pr']), number: z.number().int().positive() })
    .optional(),
  predicates: z.array(predicateSchema).optional(),
});
const rawForgeEventSelectorSchema = z.discriminatedUnion('kind', [
  selectorIdentitySchema.extend({
    kind: issueLifecycleEventSchema.shape.kind,
    actions: z.array(issueLifecycleEventSchema.shape.action).min(1),
  }),
  selectorIdentitySchema.extend({
    kind: prLifecycleEventSchema.shape.kind,
    actions: z.array(prLifecycleEventSchema.shape.action).min(1),
  }),
  selectorIdentitySchema.extend({
    kind: labelChangedEventSchema.shape.kind,
    actions: z.array(labelChangedEventSchema.shape.action).min(1),
  }),
  selectorIdentitySchema.extend({
    kind: commentChangedEventSchema.shape.kind,
    actions: z.array(commentChangedEventSchema.shape.action).min(1),
  }),
  selectorIdentitySchema.extend({
    kind: z.literal('check.changed'),
    actions: z.tuple([z.literal('changed')]),
  }),
]);
const fieldsByKind = {
  'issue.lifecycle': new Set<ForgeEventField>([
    'event.kind',
    'event.action',
    'repository.host',
    'repository.path',
    'subject.kind',
    'subject.number',
    'issue.state',
  ]),
  'pr.lifecycle': new Set<ForgeEventField>([
    'event.kind',
    'event.action',
    'repository.host',
    'repository.path',
    'subject.kind',
    'subject.number',
    'pr.state',
    'pr.draft',
    'pr.head.objectId',
    'pr.head.branch',
    'pr.base.objectId',
    'pr.base.branch',
  ]),
  'label.changed': new Set<ForgeEventField>([
    'event.kind',
    'event.action',
    'repository.host',
    'repository.path',
    'subject.kind',
    'subject.number',
    'label.name',
    'label.id',
    'label.actor.id',
    'label.actor.login',
  ]),
  'comment.changed': new Set<ForgeEventField>([
    'event.kind',
    'event.action',
    'repository.host',
    'repository.path',
    'subject.kind',
    'subject.number',
    'comment.id',
    'comment.author.id',
    'comment.author.login',
  ]),
  'check.changed': new Set<ForgeEventField>([
    'event.kind',
    'event.action',
    'repository.host',
    'repository.path',
    'check.revision',
    'check.unit.kind',
    'check.unit.id',
    'check.unit.name',
    'check.nativeState',
    'check.nativeResult',
    'check.phase',
    'check.result',
  ]),
} as const;

export const forgeEventSelectorSchema = rawForgeEventSelectorSchema.superRefine((selector, ctx) => {
  if (selector.kind === 'check.changed' && selector.subject !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['subject'],
      message: 'check.changed has no single subject',
    });
  } else if (selector.kind === 'issue.lifecycle' && selector.subject?.kind === 'pr') {
    ctx.addIssue({
      code: 'custom',
      path: ['subject', 'kind'],
      message: 'issue.lifecycle subject must be an issue',
    });
  } else if (selector.kind === 'pr.lifecycle' && selector.subject?.kind === 'issue') {
    ctx.addIssue({
      code: 'custom',
      path: ['subject', 'kind'],
      message: 'pr.lifecycle subject must be a PR',
    });
  }
  selector.predicates?.forEach((predicate, index) => {
    if (!fieldsByKind[selector.kind].has(predicate.field))
      ctx.addIssue({
        code: 'custom',
        path: ['predicates', index, 'field'],
        message: `${predicate.field} is unavailable for ${selector.kind}`,
      });
  });
});
export type ForgeEventSelector = z.infer<typeof forgeEventSelectorSchema>;

export function createForgeInputBindingSchema<T>(
  literalSchema: z.ZodType<T>
): z.ZodType<ForgeInputBinding<T>> {
  return z.discriminatedUnion('source', [
    z.object({ source: z.literal('literal'), value: literalSchema }),
    z.object({ source: z.literal('field'), field: forgeEventFieldSchema }),
  ]);
}

export function createForgeBindingSchema<T>(
  literalSchema: z.ZodType<T>
): z.ZodType<{ selector: ForgeEventSelector; inputs: Record<string, ForgeInputBinding<T>> }> {
  const inputSchema = createForgeInputBindingSchema(literalSchema);
  return z
    .object({
      selector: forgeEventSelectorSchema,
      inputs: z.record(z.string().min(1), inputSchema),
    })
    .superRefine((binding, ctx) => {
      for (const [name, input] of Object.entries(binding.inputs)) {
        if (input.source === 'field' && !fieldsByKind[binding.selector.kind].has(input.field)) {
          ctx.addIssue({
            code: 'custom',
            path: ['inputs', name, 'field'],
            message: `${input.field} is unavailable for ${binding.selector.kind}`,
          });
        }
      }
    });
}

export type ForgeInputBinding<T> =
  | { source: 'literal'; value: T }
  | { source: 'field'; field: ForgeEventField };

function eventRepo(event: ForgeEvent): RepoRef {
  switch (event.kind) {
    case 'issue.lifecycle':
      return event.issue.repo;
    case 'pr.lifecycle':
      return event.pr.repo;
    case 'label.changed':
    case 'comment.changed':
      return event.subject.ref.repo;
    case 'check.changed':
      return event.repo;
  }
}

function eventSubject(event: ForgeEvent): { kind: 'issue' | 'pr'; number: number } | undefined {
  switch (event.kind) {
    case 'issue.lifecycle':
      return { kind: 'issue', number: event.issue.number };
    case 'pr.lifecycle':
      return { kind: 'pr', number: event.pr.number };
    case 'label.changed':
    case 'comment.changed':
      return { kind: event.subject.kind, number: event.subject.ref.number };
    case 'check.changed':
      return undefined;
  }
}

type FieldReader = (event: ForgeEvent) => ForgeFieldValue | undefined;
type ForgeEventOf<K extends ForgeEvent['kind']> = Extract<ForgeEvent, { kind: K }>;

function isEventKind<K extends ForgeEvent['kind']>(
  event: ForgeEvent,
  kind: K
): event is ForgeEventOf<K> {
  return event.kind === kind;
}

/** Reads a field that only events of `kind` carry; absent (null) values read as undefined. */
function fieldOf<K extends ForgeEvent['kind']>(
  kind: K,
  read: (event: ForgeEventOf<K>) => ForgeFieldValue | null | undefined
): FieldReader {
  return event => (isEventKind(event, kind) ? (read(event) ?? undefined) : undefined);
}

const FIELD_READERS: Readonly<Record<ForgeEventField, FieldReader>> = {
  'event.kind': event => event.kind,
  'event.action': event => event.action,
  'repository.host': event => eventRepo(event).host,
  'repository.path': event => eventRepo(event).path,
  'subject.kind': event => eventSubject(event)?.kind,
  'subject.number': event => eventSubject(event)?.number,
  'issue.state': fieldOf('issue.lifecycle', event => event.state),
  'pr.state': fieldOf('pr.lifecycle', event => event.state),
  'pr.draft': fieldOf('pr.lifecycle', event => event.draft),
  'pr.head.objectId': fieldOf('pr.lifecycle', event => event.head?.objectId),
  'pr.head.branch': fieldOf('pr.lifecycle', event => event.head?.branch),
  'pr.base.objectId': fieldOf('pr.lifecycle', event => event.base?.objectId),
  'pr.base.branch': fieldOf('pr.lifecycle', event => event.base?.branch),
  'label.name': fieldOf('label.changed', event => event.label.name),
  'label.id': fieldOf('label.changed', event => event.label.id),
  'label.actor.id': fieldOf('label.changed', event => event.actor?.id),
  'label.actor.login': fieldOf('label.changed', event => event.actor?.login),
  'comment.id': fieldOf('comment.changed', event => event.comment.id),
  'comment.author.id': fieldOf('comment.changed', event => event.comment.author?.id),
  'comment.author.login': fieldOf('comment.changed', event => event.comment.author?.login),
  'check.revision': fieldOf('check.changed', event => event.revision),
  'check.unit.kind': fieldOf('check.changed', event => event.unit.kind),
  'check.unit.id': fieldOf('check.changed', event => event.unit.id),
  'check.unit.name': fieldOf('check.changed', event => event.unit.name),
  'check.nativeState': fieldOf('check.changed', event => event.nativeState),
  'check.nativeResult': fieldOf('check.changed', event => event.nativeResult),
  'check.phase': fieldOf('check.changed', event => event.phase),
  'check.result': fieldOf('check.changed', event => event.result),
};

function fieldValue(event: ForgeEvent, field: ForgeEventField): ForgeFieldValue | undefined {
  return FIELD_READERS[field](event);
}

export function matchForgeEvent(selector: ForgeEventSelector, event: ForgeEvent): boolean {
  const actions: readonly string[] = selector.actions;
  if (selector.kind !== event.kind || !actions.includes(event.action)) return false;
  const repo = eventRepo(event);
  if (
    selector.repository &&
    (selector.repository.host !== repo.host || selector.repository.path !== repo.path)
  )
    return false;
  const subject = eventSubject(event);
  if (
    selector.subject &&
    (selector.subject.kind !== subject?.kind || selector.subject.number !== subject.number)
  )
    return false;
  return (selector.predicates ?? []).every(predicate => {
    const value = fieldValue(event, predicate.field);
    return predicate.equals !== undefined
      ? value === predicate.equals
      : predicate.in?.some(candidate => candidate === value) === true;
  });
}

export type MapForgeInputsResult<T> =
  | { ok: true; inputs: Record<string, T | ForgeFieldValue> }
  | { ok: false; input: string; field: ForgeEventField; reason: string };

export function mapForgeInputs<T>(
  mapping: Readonly<Record<string, ForgeInputBinding<T>>>,
  event: ForgeEvent
): MapForgeInputsResult<T> {
  const inputs: Record<string, T | ForgeFieldValue> = {};
  for (const [name, binding] of Object.entries(mapping)) {
    if (binding.source === 'literal') {
      inputs[name] = binding.value;
      continue;
    }
    const value = fieldValue(event, binding.field);
    if (value === undefined)
      return {
        ok: false,
        input: name,
        field: binding.field,
        reason: `Required event field ${binding.field} is unavailable`,
      };
    inputs[name] = value;
  }
  return { ok: true, inputs };
}
