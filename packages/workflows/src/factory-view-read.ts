/**
 * A pack's view file (`schemas/factory-view.ts`) read so that a key it does not have costs only
 * itself: the envelope (version, summary and How it works) must read, or the file is
 * `unreadable` and there is no view; a key the schema does not know, at the top (an older
 * file's `stages`, `outcomes` or `rounds`) or inside the picture (a misspelt key), is reported
 * `unknown` and left out.
 *
 * `servedFactoryView` is the one path from a file's JSON to what a console draws: this read,
 * then the reconcile with the pack graph (`factory-view-check.ts`). The view route and
 * `bun run check:factory-view` both call it, so the two cannot disagree.
 */
import type { z } from 'zod';
import { reconcileFactoryView } from './factory-view-check';
import type { PackGraph } from './pack-graph';
import {
  factoryViewSchema,
  type FactoryView,
  type FactoryViewProblem,
} from './schemas/factory-view';

/** A read: the view (null when the file is unreadable) and every problem found reading it. */
export interface FactoryViewRead {
  view: FactoryView | null;
  problems: FactoryViewProblem[];
}

type Issue = z.core.$ZodIssue;

const issuePath = (issue: Issue): FactoryViewProblem['path'] =>
  issue.path.map(key => (typeof key === 'number' ? key : String(key)));

const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === 'object' && input !== null && !Array.isArray(input);

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

/**
 * The fate of every top-level key an older view file had: the one place that says where each
 * moved, or that it was removed, so a message never points a reader somewhere that refuses it.
 * Words and declarations moved into the pack's YAML (each workflow's `display:` block, its
 * nodes' `display.label`, and the pack document's front matter); the rest were dropped.
 */
const OLD_KEYS: Readonly<Record<string, string>> = {
  stages:
    "moved: a stage's label, short line and blurb are its workflow's display: block, its drill-down is display.phases, and each step's name is its node's display.label",
  outcomes:
    "moved: an outcome's label and story are display.outcomes in its workflow, and a stage's `*` story is display.story",
  answers: "moved: an ask option's label is display.answers in its workflow",
  rounds:
    'moved: display.results (round, allowance) in the stage, or display.replaces loops for a retired workflow',
  returns: 'moved: display.marks with means: returns in the stage',
  approves: 'moved: display.marks with means: approves in the stage',
  change: 'moved: display.results (change) in the stage',
  retired: 'moved: display.replaces in the stage that replaced the workflow',
  words: "moved: the pack document's front matter (`words`)",
  merged: "moved: the pack document's front matter (`exit`)",
  groups: "moved: the pack document's front matter (`groups`)",
  title: 'removed: nothing reads it; delete it',
  map: 'removed: the map is drawn from the pack graph; delete it',
};

/** What a top-level key the file does not have is told: its fate, when an older file had it. */
function unknownRootKey(key: string): string {
  const fate = OLD_KEYS[key];
  return fate === undefined
    ? 'is not a key a view file has'
    : `is not a key a view file has any more: ${fate}`;
}

const unreadable = (issue: Issue | undefined): FactoryViewRead => ({
  view: null,
  problems: [
    {
      kind: 'unreadable',
      path: issue === undefined ? [] : issuePath(issue),
      message: `${issue?.message ?? 'does not read'}: the file does not read`,
    },
  ],
});

/**
 * The file's JSON read. A file whose only fault is keys the schema does not know reads without
 * them, each reported `unknown`; any other fault makes it unreadable.
 */
export function readFactoryView(json: unknown): FactoryViewRead {
  const first = factoryViewSchema.safeParse(json);
  if (first.success) return { view: first.data, problems: [] };
  const { issues } = first.error;
  if (!issues.every(issue => issue.code === 'unrecognized_keys')) return unreadable(issues[0]);
  const again = factoryViewSchema.safeParse(withoutKeys(json, issues));
  if (!again.success) return unreadable(again.error.issues[0]);
  return {
    view: again.data,
    problems: issues.flatMap(issue =>
      issue.code === 'unrecognized_keys'
        ? issue.keys.map(
            (key): FactoryViewProblem => ({
              kind: 'unknown',
              path: [...issuePath(issue), key],
              message:
                issue.path.length === 0 ? unknownRootKey(key) : 'is not a key a view file has',
            })
          )
        : []
    ),
  };
}

/**
 * What a console draws from a view file's JSON against the pack graph it was read with: the
 * explainer as it reads, its picture reconciled with the graph, and every problem on the way.
 */
export function servedFactoryView(json: unknown, graph: PackGraph): FactoryViewRead {
  const read = readFactoryView(json);
  if (read.view === null) return read;
  const reconciled = reconcileFactoryView(read.view, graph);
  return { view: reconciled.view, problems: [...read.problems, ...reconciled.problems] };
}
