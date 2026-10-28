import { z } from 'zod';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { validateStructuredOutput } from '../structured-output';
import { resolvedBodyNodes } from '../graph-plan';
import { canonicalValueText, COMPOSITION_KEYWORDS } from '../output-ref';
import {
  isGateNode,
  isHaltNode,
  isComposeFanOutNode,
  isLoopGroupNode,
  definedOutputPaths,
  isLoopNode,
  isWaitNode,
  isWorkflowNode,
  type DagNode,
  type NodeOutput,
  type ResolvedWorkflow,
} from '../schemas';
import { loopIterationCompletes } from './loop-completion';

export const dryRunStubValueSchema = z.union([
  z.string(),
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
  z.number(),
  z.boolean(),
  z.null(),
]);
export type DryRunStubValue = z.infer<typeof dryRunStubValueSchema>;
export const dryRunStubsSchema = z.unknown().transform((value, ctx) => {
  if (!isRecord(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'expected a mapping of node ids to outputs',
    });
    return z.NEVER;
  }

  const entries: [string, DryRunStubValue][] = [];
  let invalid = false;
  for (const [id, candidate] of Object.entries(value)) {
    const result = dryRunStubValueSchema.safeParse(candidate);
    if (!result.success) {
      invalid = true;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [id],
        message: result.error.issues.map(issue => issue.message).join('; '),
      });
      continue;
    }
    // Validation establishes the union; retaining the raw value preserves own keys
    // such as `__proto__` across the YAML → Zod boundary.
    entries.push([id, candidate as DryRunStubValue]);
  }
  return invalid ? z.NEVER : Object.fromEntries(entries);
});
export type DryRunStubs = z.infer<typeof dryRunStubsSchema>;

/** Reserved keys of the `.stubs.yaml` fixture format (#2772); `loadDryRunStubs` rejects them so a fixture file is never mis-read as plain stubs. */
export const RESERVED_FIXTURE_KEYS = new Set(['fixture', 'exec-code']);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStubValue(value: unknown): value is DryRunStubValue {
  return dryRunStubValueSchema.safeParse(value).success;
}

function objectPlaceholder(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((name): name is string => typeof name === 'string')
    : [];
  return Object.fromEntries(required.map(name => [name, schemaPlaceholder(properties[name])]));
}

function nonnegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) ? Math.max(0, value) : 0;
}

function composedPlaceholderSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const branches = COMPOSITION_KEYWORDS.flatMap(keyword => {
    const values = schema[keyword];
    if (!Array.isArray(values)) return [];
    // One deterministic candidate, not a search over branch combinations. The original
    // schema still validates the result and rejects candidates we cannot satisfy.
    return keyword === 'allOf' ? values : values.slice(0, 1);
  });
  if (branches.length === 0) return schema;
  const parts = [schema, ...branches.filter(isRecord).map(composedPlaceholderSchema)];
  const merged: Record<string, unknown> = Object.assign({}, ...parts);
  if (!parts.some(part => isRecord(part.properties))) return merged;
  const properties = new Map<string, unknown>();
  for (const part of parts) {
    for (const [key, value] of Object.entries(isRecord(part.properties) ? part.properties : {})) {
      properties.set(key, properties.has(key) ? { allOf: [properties.get(key), value] } : value);
    }
  }
  const required = parts.flatMap(part =>
    Array.isArray(part.required)
      ? part.required.filter((key): key is string => typeof key === 'string')
      : []
  );
  return {
    ...merged,
    type: merged.type ?? 'object',
    properties: Object.fromEntries(properties),
    required: [...new Set(required)],
  };
}

function schemaPlaceholder(input: unknown): unknown {
  if (!isRecord(input)) return 'TODO';
  const value = placeholderFromSchema(input);
  if (
    !COMPOSITION_KEYWORDS.some(keyword => Array.isArray(input[keyword])) ||
    validateStructuredOutput(value, input).valid
  ) {
    return value;
  }
  return placeholderFromSchema(composedPlaceholderSchema(input));
}

function placeholderFromSchema(schema: Record<string, unknown>): unknown {
  if ('const' in schema) return structuredClone(schema.const);
  if ('default' in schema) return structuredClone(schema.default);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return structuredClone(schema.enum[0]);
  }

  switch (schema.type) {
    case 'object':
      return objectPlaceholder(schema);
    case 'array': {
      const minItems = nonnegativeInteger(schema.minItems);
      return Array.from({ length: minItems }, () => schemaPlaceholder(schema.items));
    }
    case 'boolean':
      return false;
    case 'integer':
      return typeof schema.minimum === 'number' ? Math.ceil(schema.minimum) : 0;
    case 'number':
      return typeof schema.minimum === 'number' ? schema.minimum : 0;
    case 'null':
      return null;
    case 'string': {
      const minLength = nonnegativeInteger(schema.minLength);
      return minLength > 4 ? 'T'.repeat(minLength) : 'TODO';
    }
    default:
      return 'TODO';
  }
}

export function generatedStubFor(node: DagNode): DryRunStubValue {
  if (node.output_format === undefined) {
    return isLoopNode(node) && node.loop.until !== undefined ? node.loop.until : 'TODO';
  }
  if (node.output_format.$async === true) {
    throw new Error(
      `Cannot generate dry-run stub for node '${node.id}': asynchronous output_format schemas are unsupported`
    );
  }

  const value = schemaPlaceholder(node.output_format);
  if (isLoopNode(node) && node.loop.until_field !== undefined) {
    if (!isRecord(value)) {
      throw new Error(
        `Cannot generate dry-run stub for node '${node.id}': loop.until_field requires an object-typed output_format`
      );
    }
    value[node.loop.until_field] = true;
  }

  let compileError: string | undefined;
  const validation = validateStructuredOutput(value, node.output_format, message => {
    compileError = message;
  });
  if (compileError !== undefined) {
    throw new Error(
      `Cannot generate dry-run stub for node '${node.id}': output_format could not be compiled (${compileError})`
    );
  }
  if (!validation.valid) {
    throw new Error(
      `Cannot generate schema-valid dry-run stub for node '${node.id}': ${validation.errors.join('; ')}`
    );
  }
  if (!isStubValue(value)) {
    throw new Error(
      `Cannot generate dry-run stub for node '${node.id}': output_format produced a placeholder of an unsupported type`
    );
  }
  return typeof value === 'string' ? JSON.stringify(value) : value;
}

function stubSatisfiesNode(node: DagNode, stub: DryRunStubValue): boolean {
  try {
    assertAuthoredStubSatisfiesSchema(node, stub);
  } catch {
    return false;
  }
  if (isLoopNode(node)) {
    return loopIterationCompletes(node.loop, completedOutput(node, stub)).kind !== 'incomplete';
  }
  return true;
}

/**
 * An authored stub stands in for a node's real output, so it owes the same contract.
 *
 * The generated-scaffold route already validates its placeholder against
 * `output_format` (`generatedStubFor` throws on a schema it cannot satisfy); this is
 * that check for a value a fixture wrote by hand, which otherwise reached
 * `completedOutput` unexamined. Without it a fixture keeps passing while the schema it
 * stands in for moves, and the suite's green stops meaning the real run would certify.
 * Throwing here is what the surrounding catch turns into a failed node, so the fixture
 * reports the schema errors rather than a downstream symptom.
 *
 * Called from `stubFor`, the single point an authored stub enters a simulation, so a
 * new consumer cannot forget it. It sat at the two hydration sites first and one of
 * them was missed — the loop one, which is the one that matters most: `loop:` is how
 * a workflow declares an iterated verdict, so its schema is usually the contract a
 * composition is built on.
 */
export function assertAuthoredStubSatisfiesSchema(node: DagNode, stub: DryRunStubValue): void {
  if (node.output_format === undefined) return;
  // A string stub stands in for what the node PRINTS, which the engine parses before
  // it validates; a non-string stub already is the structured value. Parse the first
  // the way `certifyExecOutput` does, so a fixture may keep writing either form and
  // both are held to the same contract.
  let value: unknown = stub;
  if (typeof stub === 'string') {
    try {
      value = JSON.parse(stub);
    } catch {
      throw new Error(
        `Stub for node '${node.id}' declares output_format but is not one JSON document: ` +
          stub.slice(0, 120)
      );
    }
  }
  let compileError: string | undefined;
  const validation = validateStructuredOutput(value, node.output_format, message => {
    compileError = message;
  });
  if (compileError !== undefined) {
    throw new Error(
      `Stub for node '${node.id}' cannot be checked: its output_format could not be ` +
        `compiled (${compileError})`
    );
  }
  if (!validation.valid) {
    throw new Error(
      `Stub for node '${node.id}' does not satisfy its output_format: ` +
        validation.errors.join('; ')
    );
  }
}

function collectsStub(node: DagNode): boolean {
  // `include:` is no longer a DagNode member (#2486) — it never reaches this function.
  return !(
    isGateNode(node) ||
    isWaitNode(node) ||
    isHaltNode(node) ||
    isWorkflowNode(node) ||
    isComposeFanOutNode(node) ||
    isLoopGroupNode(node)
  );
}

/** Build the complete static stub map for an already-expanded workflow definition. */
export function createDryRunStubScaffold(workflow: ResolvedWorkflow): DryRunStubs {
  const stubs = new Map<string, { candidates: DryRunStubValue[]; consumers: DagNode[] }>();
  const visit = (nodes: readonly DagNode[]): void => {
    for (const node of nodes) {
      if (collectsStub(node)) {
        const generated = generatedStubFor(node);
        const existing = stubs.get(node.id);
        if (existing === undefined) {
          stubs.set(node.id, { candidates: [generated], consumers: [node] });
        } else {
          existing.candidates.push(generated);
          existing.consumers.push(node);
        }
      }
      if (isLoopGroupNode(node)) visit(resolvedBodyNodes(node.loop_group));
    }
  };
  visit(workflow.nodes);
  return Object.fromEntries(
    [...stubs].map(([id, entry]) => {
      const value = entry.candidates.find(candidate =>
        entry.consumers.every(consumer => stubSatisfiesNode(consumer, candidate))
      );
      if (value === undefined) {
        throw new Error(
          `Cannot generate dry-run scaffold: nodes sharing stub key '${id}' require incompatible values`
        );
      }
      return [id, value];
    })
  );
}

/** Write a scaffold without ever overwriting an existing fixture. */
export async function writeDryRunStubScaffold(
  workflow: ResolvedWorkflow,
  path: string
): Promise<DryRunStubs> {
  const stubs = createDryRunStubScaffold(workflow);
  await mkdir(dirname(path), { recursive: true });
  let handle;
  try {
    handle = await open(path, 'wx');
    await handle.writeFile(Bun.YAML.stringify(stubs, null, 2));
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'EEXIST') {
      throw new Error(`Dry-run stub scaffold already exists: ${path}`);
    }
    throw error;
  } finally {
    await handle?.close();
  }
  return stubs;
}

export async function loadDryRunStubs(path?: string): Promise<DryRunStubs> {
  if (!path) return {};
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`Dry-run stub file not found: ${path}`);
  }

  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(await file.text());
  } catch (error) {
    throw new Error(`Failed to parse dry-run stub file '${path}': ${(error as Error).message}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `Invalid dry-run stub file '${path}': expected one YAML mapping of node ids to outputs`
    );
  }
  const reservedHit = Object.keys(parsed as Record<string, unknown>).find(key =>
    RESERVED_FIXTURE_KEYS.has(key)
  );
  if (reservedHit !== undefined) {
    throw new Error(
      `Invalid dry-run stub file '${path}': contains the fixture key '${reservedHit}' — this is a fixture file; run it with 'workflow test'`
    );
  }
  const result = dryRunStubsSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid dry-run stub file '${path}': ${issues}`);
  }
  return result.data;
}

export function completedOutput(node: DagNode, stub: DryRunStubValue): NodeOutput {
  const declaredOutputPaths = definedOutputPaths(node);
  const contract = declaredOutputPaths !== undefined ? { declaredOutputPaths } : {};
  if (typeof stub === 'string') {
    const structuredOutput: unknown =
      node.output_format === undefined ? undefined : JSON.parse(stub);
    return {
      state: 'completed',
      output: node.output_format === undefined ? stub : canonicalValueText(structuredOutput),
      ...(node.output_format === undefined ? {} : { structuredOutput }),
      ...contract,
    };
  }
  return {
    state: 'completed',
    output: JSON.stringify(stub),
    structuredOutput: stub,
    ...contract,
  };
}
