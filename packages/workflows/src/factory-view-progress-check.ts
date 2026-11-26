/**
 * A factory view's progress declarations (`schemas/factory-view-progress.ts`) reconciled with
 * the pack graph. `reconcileFactoryView` runs this with the rest of the view's reconcile.
 *
 * - A declaration's `workflow` is a graph stage, or one the view lists in `retired`. One naming
 *   neither is KEPT, and its workflow is served as retired (reported `retired`): a renamed stage
 *   leaves old runs under the old name, and a board card reads their rounds and returns from
 *   it (DESIGN.md, COMBINED direction).
 * - A `retired` entry's `stage` (where its items stand on the board) is a stage of the graph's
 *   flow; one the graph lacks or has outside the flow is dropped, and the entry kept bare.
 * - For a graph stage, a decision point's `node` is one of the stage's step ids and a loop-form
 *   rounds source's `loop` is one of its loop groups; one that is not is dropped. A retired
 *   workflow's steps cannot be compared with a graph that lacks them, so they are not checked.
 * - A `retired` entry the graph has is `invalid`, as is a duplicate, and so is a workflow a
 *   `rounds` or `change` list names twice: the file says two things, which no drift causes.
 * - A decision point's `outcome` is checked only as non-empty: the graph declares a stage's
 *   outcome values, not the values each step records.
 * - "Returned" has two owners that must agree: `returns` counts sends-back, and an outcome's
 *   `reads: "returned"` says how the item reads after its run. A stage with either has both. A
 *   file that disagrees as written is `invalid`; where a drop leaves one half alone, that half
 *   is dropped too (an outcome keeps its words and loses only `reads`).
 */
import type { PackGraph } from './pack-graph';
import type { Reconciling } from './factory-view-check';
import type { FactoryView, FactoryViewProblem } from './schemas/factory-view';
import {
  retiredEntries,
  sourcesOf,
  type FactoryDecisionPoint,
} from './schemas/factory-view-progress';

type ProblemPath = FactoryViewProblem['path'];
type GraphStage = PackGraph['stages'][number];

/**
 * `retired` names only workflows the graph lacks, each once, and places each at a stage of the
 * graph's flow; a placement that is not is dropped, its workflow kept retired.
 */
function retiredErrors(r: Reconciling): void {
  const seen = new Set<string>();
  retiredEntries(r.view).forEach(({ workflow: name, stage }, i) => {
    if (seen.has(name)) r.add('invalid', ['retired', i], `retires "${name}" twice`);
    seen.add(name);
    if (r.stages.has(name))
      r.add('invalid', ['retired', i], `retires "${name}", which the pack graph has`);
    if (stage === null || r.stages.get(stage)?.inFlow === true) return;
    r.add(
      'dropped',
      ['retired', i, 'stage'],
      r.stages.has(stage)
        ? `places "${name}" at stage "${stage}", which is not in the pack's flow`
        : `places "${name}" at stage "${stage}", which the pack graph does not have`
    );
    if (r.view.retired !== undefined) r.view.retired[i] = name;
  });
}

/**
 * The graph stage a declaration names, or 'retired' for a workflow the graph lacks. One the
 * file does not retire is retired here, reported once per entry, and served in `retired`.
 */
function stageOrRetired(
  r: Reconciling,
  implied: Set<string>,
  path: ProblemPath,
  workflow: string
): GraphStage | 'retired' {
  const stage = r.stages.get(workflow);
  if (stage !== undefined) return stage;
  if (!retiredEntries(r.view).some(entry => entry.workflow === workflow)) {
    implied.add(workflow);
    r.add(
      'retired',
      path,
      `names workflow "${workflow}", which pack "${r.graph.pack}" does not have: kept as retired, so its runs still count`
    );
  }
  return 'retired';
}

/** The decision points of `key` whose node the named graph stage has, and retired ones. */
function reconcilePoints(r: Reconciling, implied: Set<string>, key: 'returns' | 'approves') {
  const points = r.view[key];
  if (points === undefined) return;
  const kept = points.filter((point, p) => {
    const stage = stageOrRetired(r, implied, [key, p, 'workflow'], point.workflow);
    if (stage === 'retired' || stage.nodes.some(node => node.id === point.node)) return true;
    r.add(
      'dropped',
      [key, p, 'node'],
      `names step "${point.node}", which stage "${point.workflow}" does not have`
    );
    return false;
  });
  if (kept.length > 0) r.view[key] = kept;
  else delete r.view[key];
}

/**
 * The sources of `rounds` or `change` whose loop the named graph stage has, and retired ones, in
 * the form they were declared in (one source or a list); undefined when none is left.
 */
function keptSources<T extends { workflow: string; loop?: string }>(
  r: Reconciling,
  implied: Set<string>,
  key: 'rounds' | 'change',
  declared: T | T[] | undefined
): T | T[] | undefined {
  const single = declared !== undefined && !Array.isArray(declared);
  const pathOf = (index: number): ProblemPath => (single ? [key] : [key, index]);
  const sources = sourcesOf(declared);
  const workflows = sources.map(source => source.workflow);
  const kept = sources.filter((source, index) => {
    if (workflows.indexOf(source.workflow) !== index)
      r.add('invalid', pathOf(index), `names workflow "${source.workflow}" twice`);
    const stage = stageOrRetired(r, implied, [...pathOf(index), 'workflow'], source.workflow);
    if (stage === 'retired' || source.loop === undefined) return true;
    if (stage.nodes.some(node => node.loopGroup === source.loop)) return true;
    r.add(
      'dropped',
      [...pathOf(index), 'loop'],
      `names loop "${source.loop}", which stage "${source.workflow}" does not have`
    );
    return false;
  });
  if (kept.length === 0) return undefined;
  return single ? declared : kept;
}

/** The `rounds` and `change` sources kept. */
function reconcileSources(r: Reconciling, implied: Set<string>): void {
  const rounds = keptSources(r, implied, 'rounds', r.view.rounds);
  if (rounds === undefined) delete r.view.rounds;
  else r.view.rounds = rounds;
  const change = keptSources(r, implied, 'change', r.view.change);
  if (change === undefined) delete r.view.change;
  else r.view.change = change;
}

const splitStage = (key: string): string => key.slice(0, key.lastIndexOf(':'));

/** Where `view`'s two owners of "returned" disagree: outcome keys and `returns` workflows. */
function disagreements(
  view: FactoryView,
  stages: ReadonlyMap<string, GraphStage>
): { outcomes: Set<string>; returns: Set<string> } {
  const counted = new Set((view.returns ?? []).map(point => point.workflow));
  const reads = new Set<string>();
  const outcomes = new Set<string>();
  for (const [key, outcome] of Object.entries(view.outcomes ?? {})) {
    if (outcome.reads !== 'returned') continue;
    const stage = splitStage(key);
    reads.add(stage);
    if (!counted.has(stage)) outcomes.add(key);
  }
  const returns = new Set(
    (view.returns ?? [])
      .map(point => point.workflow)
      .filter(workflow => stages.has(workflow) && !reads.has(workflow))
  );
  return { outcomes, returns };
}

const samePoint = (a: FactoryDecisionPoint, b: FactoryDecisionPoint): boolean =>
  a.workflow === b.workflow && a.node === b.node && a.outcome === b.outcome;

/** What disagrees in the file as written: `invalid`. */
function writtenDisagreements(r: Reconciling, file: FactoryView): ReturnType<typeof disagreements> {
  const written = disagreements(file, r.stages);
  (file.returns ?? []).forEach((point, p) => {
    if (written.returns.has(point.workflow))
      r.add(
        'invalid',
        ['returns', p, 'workflow'],
        `counts a return of stage "${point.workflow}", but none of its outcomes reads "returned"`
      );
  });
  for (const key of written.outcomes)
    r.add(
      'invalid',
      ['outcomes', key],
      `reads as returned, but no \`returns\` point of stage "${splitStage(key)}" counts it`
    );
  return written;
}

/**
 * Every stage with a `reads: "returned"` outcome has a `returns` point, and the reverse. `file`
 * is the view as written: what disagrees there is `invalid`, and what only a drop made disagree
 * is dropped.
 */
function reconcileReturned(r: Reconciling, file: FactoryView): void {
  const written = writtenDisagreements(r, file);
  const now = disagreements(r.view, r.stages);
  for (const key of now.outcomes) {
    const outcome = r.view.outcomes?.[key];
    if (written.outcomes.has(key) || outcome === undefined) continue;
    delete outcome.reads;
    r.add(
      'dropped',
      ['outcomes', key, 'reads'],
      `reads as returned, but no \`returns\` point of stage "${splitStage(key)}" is left to count it`
    );
  }
  const kept = (r.view.returns ?? []).filter(point => {
    if (written.returns.has(point.workflow) || !now.returns.has(point.workflow)) return true;
    r.add(
      'dropped',
      ['returns', (file.returns ?? []).findIndex(entry => samePoint(entry, point)), 'workflow'],
      `counts a return of stage "${point.workflow}", but no outcome left reads "returned"`
    );
    return false;
  });
  if (kept.length > 0) r.view.returns = kept;
  else delete r.view.returns;
}

/** Reconciles `r.view`'s progress declarations; `file` is the view as written. */
export function reconcileProgress(r: Reconciling, file: FactoryView): void {
  retiredErrors(r);
  const implied = new Set<string>();
  reconcilePoints(r, implied, 'returns');
  reconcilePoints(r, implied, 'approves');
  reconcileSources(r, implied);
  reconcileReturned(r, file);
  // After `retiredErrors`, so a workflow retired here cannot read as one the file retires twice.
  if (implied.size > 0) r.view.retired = [...(r.view.retired ?? []), ...implied];
}
