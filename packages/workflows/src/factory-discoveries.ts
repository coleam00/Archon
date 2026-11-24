/**
 * What a factory's discoveries drains decided about what agents noticed outside their scope:
 * the findings each completed drain would file (or filed), and how many it held or dropped.
 * The view file's `discoveries` field names the workflow and where in each drain's result the
 * decisions are, so nothing here names a pack's workflow or its result's keys.
 *
 * A finding counts as covered once an item on the project carries the same title (trimmed,
 * case-insensitive, exact). Covering needs every item of the project, not a board's page, so
 * `readFactoryDiscoveries` reads them all; the decisions themselves are pure
 * (`drainDecisions`, `coveredBy`).
 */
import { z } from 'zod';
import { itemTitle } from './factory-items';
import { factoryRunWorkflowName } from './factory-views';
import { readItemRuns } from './item-read';
import { resolveJsonPointer } from './json-pointer';
import { nodeResultValue } from './node-result-value';
import type { JsonValue } from './output-ref';
import type { FactoryView } from './schemas/factory-view';
import type { WorkflowItem, WorkflowRun } from './schemas/workflow-run';
import type { IWorkflowStore } from './store';
import { getTerminalRecord } from './terminal-record';

type FactoryDiscoveriesDeclaration = NonNullable<FactoryView['discoveries']>;

export type DiscoveriesSource = Pick<
  IWorkflowStore,
  'listItemsInWindow' | 'getItemRuns' | 'listEventsForRuns'
>;

const factoryFindingSchema = z.object({
  title: z.string(),
  /** The drain's kind for it (the pack's word, such as `defect`); null when it gave none. */
  kind: z.string().nullable(),
  /** How the drain checked it is real; null when it said nothing. */
  verified: z.string().nullable(),
  /** The item whose drain decided it. */
  from: z.object({ key: z.string(), title: z.string().nullable() }),
  /** When that drain completed. */
  decidedAt: z.string().datetime(),
  runId: z.string(),
  /** The key of an item on the project with the same title; null while none has it. */
  coveredBy: z.string().nullable(),
});
export type FactoryFinding = z.infer<typeof factoryFindingSchema>;

export const factoryDiscoveriesSchema = z.object({
  pack: z.string(),
  /** The drains decide what they would file and file nothing. */
  shadow: z.boolean(),
  /** Drains whose result had no decisions at the declared pointers; their findings are missing. */
  unreadable: z.number().int().nonnegative(),
  held: z.number().int().nonnegative(),
  dropped: z.number().int().nonnegative(),
  /** Every finding a drain decided to file, newest drain first, each drain's in its order. */
  findings: z.array(factoryFindingSchema),
});
export type FactoryDiscoveries = z.infer<typeof factoryDiscoveriesSchema>;

interface DrainEntry {
  title: string;
  kind: string | null;
  verified: string | null;
}

interface DrainDecisions {
  filed: DrainEntry[];
  held: number;
  dropped: number;
}

const stringAt = (value: JsonValue, pointer: string | undefined): string | null => {
  if (pointer === undefined) return null;
  const found = resolveJsonPointer(value, pointer);
  return typeof found === 'string' && found.trim() !== '' ? found.trim() : null;
};

/**
 * One drain's decisions from its result. `unreadable` when a declared list is not a list or
 * a filed entry has no title: a result that does not say what it decided is reported as
 * such rather than read as having decided nothing.
 */
export function drainDecisions(
  declaration: FactoryDiscoveriesDeclaration,
  value: JsonValue
): DrainDecisions | 'unreadable' {
  const filed = resolveJsonPointer(value, declaration.filed);
  const held = resolveJsonPointer(value, declaration.held);
  const dropped = resolveJsonPointer(value, declaration.dropped);
  if (!Array.isArray(filed) || !Array.isArray(held) || !Array.isArray(dropped)) return 'unreadable';
  const entries: DrainEntry[] = [];
  for (const entry of filed) {
    const title = stringAt(entry, declaration.entry.title);
    if (title === null) return 'unreadable';
    entries.push({
      title,
      kind: stringAt(entry, declaration.entry.kind),
      verified: stringAt(entry, declaration.entry.verified),
    });
  }
  return { filed: entries, held: held.length, dropped: dropped.length };
}

const sameTitle = (title: string): string => title.trim().toLowerCase();

/** The first item, in `titles` order, whose title is `title` (trimmed, case-insensitive, exact). */
export function coveredBy(
  title: string,
  titles: ReadonlyMap<string, string | null>
): string | null {
  const wanted = sameTitle(title);
  for (const [key, candidate] of titles) {
    if (candidate !== null && sameTitle(candidate) === wanted) return key;
  }
  return null;
}

interface ReadFactoryDiscoveriesInput {
  view: FactoryView;
  pack: string;
  projectKey: string;
  /** Told of each completed drain whose result could not be read. */
  onUnreadable?: (runId: string) => void;
}

/** A page of items while reading every item of the project. */
const PAGE = 100;

interface Drain {
  run: WorkflowRun;
  itemKey: string;
}

/**
 * Every item on the project with a run, a page at a time: an item with none has no title to
 * cover a finding with.
 */
async function* everyItem(
  source: DiscoveriesSource,
  projectKey: string
): AsyncGenerator<WorkflowItem> {
  const until = new Date(Date.now() + 60_000);
  let afterItemId: string | null = null;
  for (;;) {
    const page = await source.listItemsInWindow({
      projectKey,
      since: new Date(0),
      until,
      afterItemId,
      limit: PAGE,
    });
    yield* page;
    const last = page.at(-1);
    if (page.length < PAGE || last === undefined) return;
    afterItemId = last.id;
  }
}

/** Every item on the project with its title (as the board reads it) and its completed drains. */
async function readProject(
  source: DiscoveriesSource,
  input: ReadFactoryDiscoveriesInput,
  workflow: string
): Promise<{ titles: Map<string, string | null>; drains: Drain[] }> {
  const titles = new Map<string, string | null>();
  const drains: Drain[] = [];
  const runName = factoryRunWorkflowName(input.pack, workflow);
  for await (const listed of everyItem(source, input.projectKey)) {
    const found = await readItemRuns(source, input.projectKey, listed.key);
    if (found === null) continue;
    titles.set(listed.key, itemTitle(input.view, found.runs));
    const completed = found.runs.filter(
      run => run.workflow_name === runName && run.status === 'completed'
    );
    drains.push(...completed.map(run => ({ run, itemKey: listed.key })));
  }
  return { titles, drains };
}

/** What the project's completed discoveries drains decided, read through `view.discoveries`. */
export async function readFactoryDiscoveries(
  source: DiscoveriesSource,
  input: ReadFactoryDiscoveriesInput
): Promise<FactoryDiscoveries> {
  const declaration = input.view.discoveries;
  if (declaration === undefined) throw new Error('The factory view declares no discoveries');
  const { titles, drains } = await readProject(source, input, declaration.workflow);
  const events = await source.listEventsForRuns(
    drains.map(drain => drain.run.id),
    ['workflow_completed']
  );
  const newestFirst = [...drains].sort(
    (a, b) => decidedAt(b.run).getTime() - decidedAt(a.run).getTime()
  );
  const result: FactoryDiscoveries = {
    pack: input.pack,
    shadow: declaration.shadow,
    unreadable: 0,
    held: 0,
    dropped: 0,
    findings: [],
  };
  for (const { run, itemKey } of newestFirst) {
    const record = getTerminalRecord(run.status, events.get(run.id) ?? []);
    const value =
      record?.returns.availability === 'available' ? drainValue(record.returns.value) : undefined;
    const decisions = value === undefined ? 'unreadable' : drainDecisions(declaration, value);
    if (decisions === 'unreadable') {
      result.unreadable += 1;
      input.onUnreadable?.(run.id);
      continue;
    }
    result.held += decisions.held;
    result.dropped += decisions.dropped;
    for (const entry of decisions.filed)
      result.findings.push({
        ...entry,
        from: { key: itemKey, title: titles.get(itemKey) ?? null },
        decidedAt: decidedAt(run).toISOString(),
        runId: run.id,
        coveredBy: coveredBy(entry.title, titles),
      });
  }
  return result;
}

/**
 * A drain's result as the console reads it. The terminal record holds a returns node's text
 * output as that text, so the console parses text holding JSON by its own reading rule
 * (`nodeResultValue`); a script drain returns its decisions that way. This is not the engine's
 * run-result rule, which returns a text output as the string itself.
 */
function drainValue(recorded: unknown): JsonValue | undefined {
  return typeof recorded === 'string'
    ? nodeResultValue(undefined, recorded)
    : (recorded as JsonValue);
}

/** A completed run records when it completed; one that does not counts from its start. */
const decidedAt = (run: WorkflowRun): Date => run.completed_at ?? run.started_at;
