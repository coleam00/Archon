/**
 * Schema-driven decisions: turn a JSON schema into Laya questions.
 *
 * Port of `laya/structured.py` (#280). Provider-free. The mapping is a documented subset:
 * an object of properties, each an enum choice, a boolean, or a bounded integer scale.
 * Anything that cannot be answered from a fixed option set (free strings, arrays, nested
 * objects, $ref) is rejected with a SchemaError that names the path.
 *
 *     const values = await agent.decide(state, {
 *       type: "object",
 *       properties: {
 *         department: { type: "string", enum: ["billing", "support", "sales"] },
 *         urgency: { type: "integer", minimum: 0, maximum: 2 },
 *         needs_human: { type: "boolean" },
 *       },
 *     });
 *
 * Zod/TypeBox users can pass their schema's JSON form (`z.toJSONSchema(Model)`); anything
 * with a `toJSONSchema()` method is accepted.
 */
import type { QuestionDef } from './agent.js';

export const MAX_PROPERTIES = 32;
export const MAX_OPTIONS = 32;
export const MAX_SCORE_LEVELS = 10;

/** A schema cannot be expressed as Laya questions; the message names the path. */
export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaError';
  }
}

/** The detailed result of `decide(..., { returnDetails: true })`. */
export interface DecisionResult {
  /** Schema-shaped output (choice values, integer levels, booleans). */
  values: Record<string, unknown>;
  /** Per-field confidence. */
  confidence: Record<string, number>;
  /** Per-field probabilities (noul fields report { false, true }). */
  probabilities: Record<string, Record<string, unknown>>;
  /** Laya's raw answer per field. */
  answers: Record<string, unknown>;
  usage?: unknown;
  routing?: unknown;
}

/** One planned field: the Laya question plus how to project its answer back. */
export interface PlannedField {
  name: string;
  kind: 'choice' | 'score' | 'noul';
  question: QuestionDef;
  /** choice: (label, value) pairs, in enum order. */
  options?: [string, unknown][];
  /** score: value of level 0. */
  minimum?: number;
}

/** Anything with an async predict(state, questions, opts) — Agent and Router both qualify. */
export interface DecideRunner {
  predict(
    state: unknown,
    questions: Record<string, QuestionDef>,
    opts?: Record<string, unknown>
  ): Promise<{
    answers?: Record<string, Record<string, any> | undefined>;
    usage?: unknown;
    routing?: unknown;
  }>;
}

export interface DecideOptions {
  /** Explicit questions instead of a schema (answers are returned unprojected). */
  questions?: Record<string, QuestionDef>;
  /** Return a DecisionResult with confidence, probabilities and raw answers. */
  returnDetails?: boolean;
  /** Anything else is forwarded to runner.predict (hooks, model, ...). */
  [k: string]: unknown;
}

const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;

function pyType(v: unknown): string {
  if (v === null || v === undefined) return 'NoneType';
  if (Array.isArray(v)) return 'list';
  switch (typeof v) {
    case 'boolean':
      return 'bool';
    case 'number':
      return Number.isInteger(v) ? 'int' : 'float';
    case 'string':
      return 'str';
    case 'object':
      return 'dict';
    default:
      return typeof v;
  }
}

/** Accept a JSON schema object or a model exposing toJSONSchema()/model_json_schema()/schema(). */
function schemaOf(model: unknown): Record<string, unknown> {
  const m = model as Record<string, any>;
  for (const key of ['toJSONSchema', 'model_json_schema', 'schema']) {
    if (typeof m?.[key] === 'function') return m[key]();
  }
  if (m !== null && typeof m === 'object' && !Array.isArray(m)) return m;
  throw new SchemaError(
    `expected a JSON schema object or a model with toJSONSchema(), got ${pyType(model)}`
  );
}

function noulField(name: string, description: unknown): PlannedField {
  return {
    name,
    kind: 'noul',
    question: { type: 'noul', instructions: description || `Is \`${name}\` true?` },
  };
}

function enumField(
  path: string,
  name: string,
  values: unknown[],
  description: unknown
): PlannedField {
  if (values.length > MAX_OPTIONS) {
    throw new SchemaError(`${path}: ${values.length} options exceeds MAX_OPTIONS=${MAX_OPTIONS}`);
  }
  if (values.length === 0) throw new SchemaError(`${path}: 'enum' must not be empty`);
  if (values.every(v => typeof v === 'boolean')) return noulField(name, description);
  const options: [string, unknown][] = values.map(v => [v == null ? 'null' : String(v), v]);
  if (new Set(options.map(([label]) => label)).size !== options.length) {
    throw new SchemaError(`${path}: enum values produce duplicate choice labels`);
  }
  return {
    name,
    kind: 'choice',
    question: {
      type: 'choice',
      instructions: description || `What is \`${name}\`?`,
      criteria: Object.fromEntries(options.map(([label]) => [label, null])),
    },
    options,
  };
}

function scoreField(
  path: string,
  name: string,
  prop: Record<string, unknown>,
  description: unknown
): PlannedField {
  const lo = prop.minimum;
  const hi = prop.maximum;
  if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
    throw new SchemaError(
      `${path}: a numeric field needs integer 'minimum' and 'maximum' to become a score`
    );
  }
  const loN = lo as number;
  const hiN = hi as number;
  if (hiN < loN) throw new SchemaError(`${path}: 'maximum' ${hiN} is below 'minimum' ${loN}`);
  const span = hiN - loN + 1;
  if (span > MAX_SCORE_LEVELS) {
    throw new SchemaError(
      `${path}: ${span} levels exceeds MAX_SCORE_LEVELS=${MAX_SCORE_LEVELS}; narrow the range or use an enum`
    );
  }
  return {
    name,
    kind: 'score',
    question: {
      type: 'score',
      instructions: description || `Score \`${name}\` from ${loN} to ${hiN}`,
      criteria: Array.from({ length: span }, (_, i) => String(loN + i)),
    },
    minimum: loN,
  };
}

function fieldFor(path: string, name: string, prop: unknown): PlannedField {
  if (prop === null || typeof prop !== 'object' || Array.isArray(prop)) {
    throw new SchemaError(`${path}: property must be an object, got ${pyType(prop)}`);
  }
  const p = prop as Record<string, unknown>;
  const description = p.description;
  if ('const' in p) return enumField(path, name, [p.const], description);
  if ('enum' in p) {
    if (!Array.isArray(p.enum))
      throw new SchemaError(`${path}: 'enum' must be a list, got ${pyType(p.enum)}`);
    return enumField(path, name, p.enum, description);
  }
  let jtype = p.type;
  if (Array.isArray(jtype)) {
    const nonNullTypes = jtype.filter(t => t !== 'null'); // nullable: ["string", "null"]
    if (nonNullTypes.length > 1) {
      throw new SchemaError(
        `${path}: 'type' has multiple non-null types; unions are not supported`
      );
    }
    jtype = nonNullTypes[0];
  }
  if (jtype === 'boolean') return noulField(name, description);
  if (jtype === 'string') {
    throw new SchemaError(
      `${path}: a free string cannot be a fixed option set; use 'enum' or a boolean`
    );
  }
  if (jtype === 'integer' || jtype === 'number') return scoreField(path, name, p, description);
  if (jtype === 'array')
    throw new SchemaError(`${path}: arrays are not supported; ask one field per element`);
  if (jtype === 'object')
    throw new SchemaError(`${path}: nested objects are not supported; flatten the schema`);
  if ('$ref' in p)
    throw new SchemaError(`${path}: $ref/recursion is not supported; flatten the schema`);
  throw new SchemaError(`${path}: unsupported schema ${JSON.stringify(prop)}`);
}

/** Validate a JSON schema and return one planned field per property. */
export function planFromJsonSchema(schema: unknown): PlannedField[] {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new SchemaError(`expected a JSON schema object, got ${pyType(schema)}`);
  }
  const s = schema as Record<string, unknown>;
  if (!(s.type === undefined || s.type === null || s.type === 'object') || !('properties' in s)) {
    throw new SchemaError("the top level must be an object with 'properties'");
  }
  const properties = s.properties;
  if (
    properties === null ||
    typeof properties !== 'object' ||
    Array.isArray(properties) ||
    Object.keys(properties).length === 0
  ) {
    throw new SchemaError("'properties' must be a non-empty object");
  }
  const entries = Object.entries(properties as Record<string, unknown>);
  if (entries.length > MAX_PROPERTIES) {
    throw new SchemaError(`${entries.length} properties exceeds MAX_PROPERTIES=${MAX_PROPERTIES}`);
  }
  return entries.map(([name, prop]) => fieldFor(`properties.${name}`, name, prop));
}

/** Turn a JSON schema into Laya questions (a documented subset; see the module docstring). */
export function questionsFromJsonSchema(schema: unknown): Record<string, QuestionDef> {
  return Object.fromEntries(planFromJsonSchema(schema).map(f => [f.name, f.question]));
}

function project(
  answers: Record<string, Record<string, any> | undefined>,
  fields: PlannedField[]
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const f of fields) {
    const answer = answers[f.name];
    if (answer == null) continue;
    if (f.kind === 'noul') {
      values[f.name] = Number(answer.noul ?? 0.0) >= 0.5;
    } else if (f.kind === 'score') {
      const probs: Record<string, unknown> = answer.probabilities ?? {};
      const n = Object.keys(probs).length;
      let idx: number;
      if (n > 0) {
        idx = 0;
        let best = -Infinity;
        for (let i = 0; i < n; i++) {
          const v = Number(probs[String(i)] ?? 0.0);
          if (v > best) {
            best = v;
            idx = i;
          }
        }
      } else {
        idx = Math.round(Number(answer.score ?? 0.0)) - (f.minimum ?? 0);
      }
      values[f.name] = (f.minimum ?? 0) + idx;
    } else {
      const label = String(answer.choice);
      const hit = (f.options ?? []).find(([l]) => l === label);
      values[f.name] = hit ? hit[1] : label;
    }
  }
  return values;
}

/** Project Laya answers onto the schema values (choice value, integer level, boolean). */
export function answersToJson(
  answers: Record<string, Record<string, any> | undefined>,
  schema: unknown
): Record<string, unknown> {
  return project(answers, planFromJsonSchema(schema));
}

function detailsOf(
  values: Record<string, unknown>,
  answers: Record<string, Record<string, any> | undefined>,
  result: { usage?: unknown; routing?: unknown }
): DecisionResult {
  const confidence: Record<string, number> = {};
  const probabilities: Record<string, Record<string, unknown>> = {};
  for (const [name, answer] of Object.entries(answers)) {
    if (answer == null) continue;
    confidence[name] = Number(answer.confidence ?? 0.0);
    if (answer.type === 'noul') {
      const p = Number(answer.noul ?? 0.0);
      probabilities[name] = { false: r4(1.0 - p), true: r4(p) };
    } else {
      probabilities[name] = { ...(answer.probabilities ?? {}) };
    }
  }
  return {
    values,
    confidence,
    probabilities,
    answers: { ...answers },
    usage: result.usage,
    routing: result.routing,
  };
}

/**
 * Answer `state` against a schema (or explicit questions) and return the decided values.
 *
 * Pass exactly one of `schema` or `opts.questions`. With `schema`, the values follow the
 * schema (choice values, integer levels, booleans). With `questions`, the raw answers are
 * returned. Extra options are forwarded to `runner.predict`.
 */
export async function decide(
  runner: DecideRunner,
  state: unknown,
  schema: unknown,
  opts: DecideOptions & { returnDetails: true }
): Promise<DecisionResult>;
export async function decide(
  runner: DecideRunner,
  state: unknown,
  schema?: unknown,
  opts?: DecideOptions
): Promise<Record<string, unknown>>;
export async function decide(
  runner: DecideRunner,
  state: unknown,
  schema?: unknown,
  opts: DecideOptions = {}
): Promise<Record<string, unknown> | DecisionResult> {
  const { questions, returnDetails = false, ...predictOpts } = opts;
  if ((schema == null) === (questions == null)) {
    throw new Error('pass exactly one of schema= or questions=');
  }
  let fields: PlannedField[] | null = null;
  let qs = questions;
  if (schema != null) {
    fields = planFromJsonSchema(schemaOf(schema));
    qs = Object.fromEntries(fields.map(f => [f.name, f.question]));
  }
  const result = await runner.predict(state, qs as Record<string, QuestionDef>, predictOpts);
  const answers = result.answers ?? {};
  const values = fields ? project(answers, fields) : { ...answers };
  if (returnDetails) return detailsOf(values, answers, result);
  return values;
}
