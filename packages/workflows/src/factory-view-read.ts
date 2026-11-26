/**
 * A pack's factory view file (`schemas/factory-view.ts`) read entry by entry, so one entry that
 * does not read costs only itself (DESIGN.md, COMBINED direction: "A stale entry drops only
 * itself, and says so"). The envelope (version, title, summary, How it works and a `stages`
 * object) must read, or the file is `unreadable` and there is no view. Then each stage,
 * outcome, answer, group, progress source and the `words` and `merged` keys are read alone
 * with their own schema: one that fails is dropped (`invalid`), and a key the schema does not
 * know is stripped from its entry or from the file (`unknown`), the rest kept.
 *
 * `servedFactoryView` is the one path from a file's JSON to what a console draws: this read,
 * then the reconcile with the pack graph (`factory-view-check.ts`). The view route and
 * `bun run check:factory-view` both call it, so the two cannot disagree.
 */
import { z } from 'zod';
import { reconcileFactoryView } from './factory-view-check';
import type { PackGraph } from './pack-graph';
import {
  answerKeySchema,
  answerSchema,
  factoryViewSchema,
  groupSchema,
  outcomeKeySchema,
  outcomeSchema,
  stageNameSchema,
  stageSchema,
  wordsSchema,
  type FactoryView,
  type FactoryViewProblem,
} from './schemas/factory-view';
import {
  changeSourceSchema,
  decisionPointSchema,
  roundsSourceSchema,
  retiredSchema,
} from './schemas/factory-view-progress';

type ProblemPath = FactoryViewProblem['path'];
type Issue = z.core.$ZodIssue;

/** A read: the view (null when the file is unreadable) and every problem found reading it. */
export interface FactoryViewRead {
  view: FactoryView | null;
  problems: FactoryViewProblem[];
}

const { shape } = factoryViewSchema;

/** What must read for there to be a view at all. `stages` is read entry by entry after. */
const envelopeSchema = z.object({
  version: shape.version,
  title: shape.title,
  summary: shape.summary,
  howItWorks: shape.howItWorks,
  stages: z.record(z.string(), z.unknown()),
});

const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === 'object' && input !== null && !Array.isArray(input);

const issuePath = (issue: Issue): ProblemPath =>
  issue.path.map(key => (typeof key === 'number' ? key : String(key)));

/** `value` without the keys `issues` (all `unrecognized_keys`) name, at their paths. */
function withoutKeys(value: unknown, issues: readonly Issue[]): unknown {
  const copy: unknown = structuredClone(value);
  for (const issue of issues) {
    if (issue.code !== 'unrecognized_keys') continue;
    let at: unknown = copy;
    for (const key of issue.path) at = isRecord(at) || Array.isArray(at) ? at[key as never] : at;
    if (isRecord(at)) for (const key of issue.keys) delete at[key];
  }
  return copy;
}

/** The problems reading one entry raised; filled by `readEntry`. */
class Reading {
  readonly problems: FactoryViewProblem[] = [];

  add(kind: FactoryViewProblem['kind'], path: ProblemPath, message: string): void {
    this.problems.push({ kind, path, message });
  }

  /**
   * `value` read with `schema`. A value whose only fault is keys the schema does not know reads
   * without them, each reported `unknown`; any other fault is the result `issues`.
   */
  parse<T>(
    schema: z.ZodType<T>,
    value: unknown,
    path: ProblemPath
  ): { data: T } | { issues: Issue[] } {
    const parsed = schema.safeParse(value);
    if (parsed.success) return { data: parsed.data };
    const { issues } = parsed.error;
    if (!issues.every(issue => issue.code === 'unrecognized_keys')) return { issues };
    const again = schema.safeParse(withoutKeys(value, issues));
    if (!again.success) return { issues: again.error.issues };
    for (const issue of issues)
      if (issue.code === 'unrecognized_keys')
        for (const key of issue.keys)
          this.add(
            'unknown',
            [...path, ...issuePath(issue), key],
            'is not a key a factory view has'
          );
    return { data: again.data };
  }

  /** One entry: its data, or undefined after reporting why it was dropped (`invalid`). */
  entry<T>(schema: z.ZodType<T>, value: unknown, path: ProblemPath): T | undefined {
    const read = this.parse(schema, value, path);
    if ('data' in read) return read.data;
    const [first] = read.issues;
    this.add(
      'invalid',
      [...path, ...(first === undefined ? [] : issuePath(first))],
      `${first?.message ?? 'does not read'}: the entry is left out`
    );
    return undefined;
  }

  /** A `{ key: entry }` object, each key and entry read alone; undefined when absent. */
  record<T>(
    keys: z.ZodType<string>,
    schema: z.ZodType<T>,
    container: unknown,
    path: ProblemPath
  ): Record<string, T> | undefined {
    if (container === undefined) return undefined;
    if (!isRecord(container)) {
      this.add('invalid', path, 'is not an object: it is left out');
      return undefined;
    }
    const kept: Record<string, T> = {};
    for (const [key, value] of Object.entries(container)) {
      const name = keys.safeParse(key);
      if (!name.success) {
        this.add('invalid', [...path, key], `${name.error.issues[0]?.message ?? 'is not a key'}`);
        continue;
      }
      const data = this.entry(schema, value, [...path, key]);
      if (data !== undefined) kept[key] = data;
    }
    return kept;
  }

  /** A list, each element read alone; undefined when absent or when nothing is left. */
  list<T>(schema: z.ZodType<T>, container: unknown, path: ProblemPath): T[] | undefined {
    if (container === undefined) return undefined;
    if (!Array.isArray(container)) {
      this.add('invalid', path, 'is not a list: it is left out');
      return undefined;
    }
    const kept = container.flatMap((value: unknown, index) => {
      const data = this.entry(schema, value, [...path, index]);
      return data === undefined ? [] : [data];
    });
    return kept.length === 0 ? undefined : kept;
  }

  /** One source or a list of them, kept in the form it was written; undefined when none reads. */
  oneOrList<T>(schema: z.ZodType<T>, container: unknown, path: ProblemPath): T | T[] | undefined {
    if (Array.isArray(container)) return this.list(schema, container, path);
    return container === undefined ? undefined : this.entry(schema, container, path);
  }
}

/** Drops the keys that are `undefined`, so the view carries only what was read. */
function defined<T extends object>(entries: T): T {
  return Object.fromEntries(
    Object.entries(entries).filter(([, value]) => value !== undefined)
  ) as T;
}

/** The file's JSON read entry by entry. */
export function readFactoryView(json: unknown): FactoryViewRead {
  const reading = new Reading();
  const envelope = reading.parse(envelopeSchema, json, []);
  if ('issues' in envelope)
    return {
      view: null,
      problems: envelope.issues.slice(0, 1).map(issue => ({
        kind: 'unreadable',
        path: issuePath(issue),
        message: `${issue.message}: the file does not read`,
      })),
    };
  const file = json as Record<string, unknown>;
  for (const key of Object.keys(file))
    if (!(key in shape)) reading.add('unknown', [key], 'is not a key a factory view has');
  const { data } = envelope;
  const candidate = defined({
    version: data.version,
    title: data.title,
    summary: data.summary,
    groups: reading.list(groupSchema, file.groups, ['groups']),
    stages: reading.record(stageNameSchema, stageSchema, data.stages, ['stages']) ?? {},
    outcomes: reading.record(outcomeKeySchema, outcomeSchema, file.outcomes, ['outcomes']),
    answers: reading.record(answerKeySchema, answerSchema, file.answers, ['answers']),
    words: file.words === undefined ? undefined : reading.entry(wordsSchema, file.words, ['words']),
    retired: reading.list(retiredSchema, file.retired, ['retired']),
    rounds: reading.oneOrList(roundsSourceSchema, file.rounds, ['rounds']),
    returns: reading.list(decisionPointSchema, file.returns, ['returns']),
    approves: reading.list(decisionPointSchema, file.approves, ['approves']),
    change: reading.oneOrList(changeSourceSchema, file.change, ['change']),
    merged:
      file.merged === undefined
        ? undefined
        : reading.entry(stageNameSchema, file.merged, ['merged']),
    howItWorks: data.howItWorks,
  });
  // Every entry read with its own schema, so the whole reads; this is the type's gate.
  const view = factoryViewSchema.safeParse(candidate);
  if (!view.success)
    return {
      view: null,
      problems: [
        ...reading.problems,
        {
          kind: 'unreadable',
          path: issuePath(view.error.issues[0] as Issue),
          message: `${view.error.issues[0]?.message ?? 'does not read'}: the file does not read`,
        },
      ],
    };
  return { view: view.data, problems: reading.problems };
}

/**
 * What a console draws from a view file's JSON against the pack graph it was read with: the
 * entries that read and name what the graph has, and every problem on the way.
 */
export function servedFactoryView(json: unknown, graph: PackGraph): FactoryViewRead {
  const read = readFactoryView(json);
  if (read.view === null) return read;
  const reconciled = reconcileFactoryView(read.view, graph);
  return { view: reconciled.view, problems: [...read.problems, ...reconciled.problems] };
}
