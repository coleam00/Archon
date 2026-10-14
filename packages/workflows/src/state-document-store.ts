import { z } from 'zod';
import { recordSurfaceSchema } from './schemas/record-surface';

export const STATE_DOCUMENT_LIMIT = 64 * 1024;
export const stateDocumentNameSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9._-]+(?:\/[a-z0-9._-]+)*$/);
export type StateValue = z.infer<ReturnType<typeof z.json>>;
function isStateValue(value: unknown, ancestors = new Set<object>()): value is StateValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return false;
  ancestors.add(value);
  const valid = (Array.isArray(value) ? [...value] : Object.values(value)).every(member =>
    isStateValue(member, ancestors)
  );
  ancestors.delete(value);
  return valid;
}
// JSON validation must preserve all own members, including __proto__.
export const stateValueSchema = z.custom<StateValue>(value => isStateValue(value));
const pointerSchema = z
  .string()
  .refine(
    path => path === '' || (path.startsWith('/') && !/~(?![01])/u.test(path)),
    'Expected an RFC 6901 JSON Pointer'
  );
export const statePatchOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), path: pointerSchema, value: stateValueSchema }).strict(),
  z.object({ op: z.literal('remove'), path: pointerSchema }).strict(),
  z.object({ op: z.literal('append'), path: pointerSchema, value: stateValueSchema }).strict(),
]);
export type StatePatchOp = z.infer<typeof statePatchOpSchema>;
const statePatchOpsSchema = z.array(statePatchOpSchema).min(1);
// A write inside a run names its run and node; any other write names only the surface
// it came through. Neither records who acted or whether a person or an agent did.
export const stateWriterSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('run'), runId: z.string().min(1), nodePath: z.string().min(1) })
    .strict(),
  z.object({ kind: z.literal('surface'), via: recordSurfaceSchema }).strict(),
]);
export type StateWriter = z.infer<typeof stateWriterSchema>;
export const stateRevisionNumberSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
export const stateOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('put') }).strict(),
  z.object({ op: z.literal('delete') }).strict(),
  // `ifRevision` is present when the patch was computed from that revision, absent when
  // it applied to whatever revision was latest.
  z
    .object({
      op: z.literal('patch'),
      ops: statePatchOpsSchema,
      ifRevision: stateRevisionNumberSchema.optional(),
    })
    .strict(),
]);
export const stateRevisionSchema = z.object({
  name: stateDocumentNameSchema,
  revision: z.number().int().positive(),
  value: stateValueSchema,
  operation: stateOperationSchema,
  writer: stateWriterSchema,
  createdAt: z.iso.datetime({ offset: true }),
});
export type StateRevision = z.infer<typeof stateRevisionSchema>;
/**
 * Where a document lives. Every project key has at least two segments (`owner/repo`,
 * `_folder/<slug>`, `_cwd/<name>`), so the one-segment install key cannot collide with one.
 */
export const stateProjectKeySchema = z.string().regex(/^[^/]+(?:\/[^/]+)+$/u);
export const stateScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('project'), key: stateProjectKeySchema }).strict(),
  z.object({ kind: z.literal('install') }).strict(),
]);
export type StateScope = z.infer<typeof stateScopeSchema>;
const INSTALL_SCOPE_KEY = '_install';
/** The storage key a store files a scope's documents under. */
export function stateScopeKey(scope: StateScope): string {
  const parsed = stateScopeSchema.parse(scope);
  return parsed.kind === 'install' ? INSTALL_SCOPE_KEY : parsed.key;
}
export const stateNamePrefixSchema = z.string().regex(/^[a-z0-9._/-]{0,200}$/u);
export const stateDocumentSummarySchema = z.object({
  name: stateDocumentNameSchema,
  revision: z.number().int().positive(),
  updatedAt: z.iso.datetime({ offset: true }),
  writer: stateWriterSchema,
  deleted: z.boolean(),
});
export type StateDocumentSummary = z.infer<typeof stateDocumentSummarySchema>;
export const stateWriteScopeSchema = z.object({
  scope: stateScopeSchema,
  name: stateDocumentNameSchema,
  writer: stateWriterSchema,
});
export const statePutSchema = stateWriteScopeSchema.extend({
  value: stateValueSchema.refine(value => value !== null, 'Use delete for a tombstone'),
  ifRevision: stateRevisionNumberSchema,
});
export const statePatchSchema = stateWriteScopeSchema.extend({
  ops: statePatchOpsSchema,
  ifRevision: stateRevisionNumberSchema.optional(),
});
export const stateDeleteSchema = stateWriteScopeSchema.extend({
  ifRevision: stateRevisionNumberSchema.optional(),
});

export class StateRevisionConflictError extends Error {
  constructor(
    public readonly name: string,
    public readonly expected: number,
    public readonly actual: number
  ) {
    super(
      `State document '${name}' revision conflict: expected ${String(expected)}, actual ${String(actual)}`
    );
  }
}
export class StateDocumentTooLargeError extends Error {
  constructor(
    public readonly name: string,
    public readonly bytes: number,
    public readonly limit = STATE_DOCUMENT_LIMIT
  ) {
    super(`State document '${name}' is ${String(bytes)} bytes; limit is ${String(limit)}`);
  }
}
export class StatePatchError extends Error {
  constructor(
    public readonly name: string,
    public readonly opIndex: number,
    public readonly reason: string
  ) {
    super(`State document '${name}' patch operation ${String(opIndex)}: ${reason}`);
  }
}

export function parseStatePatchInput(
  input: z.infer<typeof statePatchSchema>
): z.infer<typeof statePatchSchema> {
  stateWriteScopeSchema.parse(input);
  const parsed = statePatchSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new StatePatchError(
    input.name,
    typeof issue?.path[1] === 'number' ? issue.path[1] : 0,
    'Invalid patch fields'
  );
}

export function validateStateValue(value: StateValue, name = ''): void {
  stateValueSchema.parse(value);
  const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
  if (bytes > STATE_DOCUMENT_LIMIT) throw new StateDocumentTooLargeError(name, bytes);
}

type Container = StateValue[] | Record<string, StateValue>;
function container(value: StateValue): Container {
  if (value === null || typeof value !== 'object')
    throw new Error('Pointer traverses a non-container');
  return value;
}
function arrayIndex(key: string, length: number, allowEnd: boolean): number {
  if (!/^(0|[1-9][0-9]*)$/u.test(key)) throw new Error('Invalid array index');
  const index = Number(key);
  if (!Number.isSafeInteger(index) || index > length || (!allowEnd && index === length))
    throw new Error('Array index out of bounds');
  return index;
}
function read(parent: Container, key: string): StateValue | undefined {
  return Array.isArray(parent)
    ? parent[arrayIndex(key, parent.length, true)]
    : Object.hasOwn(parent, key)
      ? parent[key]
      : undefined;
}
function set(parent: Container, key: string, value: StateValue): void {
  if (Array.isArray(parent)) parent[arrayIndex(key, parent.length, true)] = value;
  else
    Object.defineProperty(parent, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
}

export function applyStatePatch(
  value: StateValue,
  ops: readonly StatePatchOp[],
  name = ''
): StateValue {
  let result = structuredClone(value);
  if (ops.length === 0) throw new StatePatchError(name, 0, 'Expected at least one operation');
  for (const [opIndex, supplied] of ops.entries()) {
    try {
      const op = statePatchOpSchema.parse(supplied);
      const segments =
        op.path === ''
          ? []
          : op.path
              .slice(1)
              .split('/')
              .map(segment => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
      if (segments.length === 0) {
        if (op.op === 'set') result = structuredClone(op.value);
        else if (op.op === 'remove') throw new Error('Use delete to remove the document');
        else {
          if (!Array.isArray(result)) throw new Error('Append target must be an array');
          result.push(structuredClone(op.value));
        }
      } else {
        let parent = container(result);
        for (const key of segments.slice(0, -1)) {
          let child = read(parent, key);
          if (child === undefined && op.op !== 'remove') {
            child = {};
            set(parent, key, child);
          }
          if (child === undefined) throw new Error('Pointer does not exist');
          parent = container(child);
        }
        const key = segments.pop();
        if (key === undefined) throw new Error('Missing pointer target');
        if (op.op === 'set') set(parent, key, structuredClone(op.value));
        else if (op.op === 'remove') {
          if (read(parent, key) === undefined) throw new Error('Pointer does not exist');
          if (Array.isArray(parent)) parent.splice(arrayIndex(key, parent.length, false), 1);
          else Reflect.deleteProperty(parent, key);
        } else {
          let target = read(parent, key);
          if (target === undefined) {
            target = [];
            set(parent, key, target);
          }
          if (!Array.isArray(target)) throw new Error('Append target must be an array');
          target.push(structuredClone(op.value));
        }
      }
      if (result === null) throw new Error('Use delete for a tombstone');
      validateStateValue(result, name);
    } catch (error) {
      if (error instanceof StateDocumentTooLargeError) throw error;
      throw new StatePatchError(
        name,
        opIndex,
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  return result;
}

/** The operation a patch records: its ops, plus the revision it named, if any. */
export function statePatchOperation(
  input: z.infer<typeof statePatchSchema>
): Extract<StateRevision['operation'], { op: 'patch' }> {
  return {
    op: 'patch',
    ops: input.ops,
    ...(input.ifRevision !== undefined ? { ifRevision: input.ifRevision } : {}),
  };
}

export interface IStateDocumentStore {
  getStateDocument(scope: StateScope, name: string): Promise<StateRevision | null>;
  putStateDocument(input: z.infer<typeof statePutSchema>): Promise<StateRevision>;
  patchStateDocument(input: z.infer<typeof statePatchSchema>): Promise<StateRevision>;
  deleteStateDocument(input: z.infer<typeof stateDeleteSchema>): Promise<StateRevision>;
  listStateRevisions(
    scope: StateScope,
    name: string,
    options?: { limit?: number }
  ): Promise<StateRevision[]>;
  /** Names with their latest revision, ordered by name; never values. */
  listStateDocuments(
    scope: StateScope,
    options?: { prefix?: string }
  ): Promise<StateDocumentSummary[]>;
  pruneStateRevisions(olderThanDays: number): Promise<{ count: number }>;
}
