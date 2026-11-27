/**
 * A pack's stage graph as this install has it: its stages, the outcomes each can end
 * with, each stage's nodes and their edges, and the arrows between stages (a run that
 * ended with an outcome, or the settling of the asks a run left), each marked active (a
 * trigger file in the install launches it) or declared and inactive (the pack's
 * `.pack/pack.yaml` declares it and no file does). It reports only what the engine
 * already reads: no arrow is declared here.
 *
 * `archon pack graph` and `GET /api/packs/{pack}/graph` return this one shape. An item's
 * path through the stages is the item read (`readItem`): each run's workflow is a stage,
 * and a `run_ended` cause names the run that ended and the arrow (`sourceInstanceId`) that
 * started the next.
 */
import { observesItem } from './schemas/item-role';
import { stageAskOptions, stageAskOptionsSchema } from './schemas/ask-option';
import { z } from 'zod';
import { declaredItemFate, declaredOutcome, outcomeValues } from './completed-outcome';
import type { PackBinding } from './schemas/pack-bindings';
import { kindedPackBinding } from './schemas/pack-bindings';
import { resolvedBodyNodes } from './graph-plan';
import { fanOutBlocks, stageNodes } from './pack-graph-nodes';
import { isLoopGroupNode } from './schemas/node-guards';
import { isBinaryBuild } from './defaults/bundled-defaults';
import { packGroupSchema, packWordsSchema } from './pack-document';
import { metricViewSchema } from './schemas/metric-view';
import {
  nodeDisplaySchema,
  outcomeDisplaySchema,
  outcomeWords,
  stageDisplay,
  stageDisplaySchema,
} from './schemas/display';
import { asksSettledTriggerSchema } from './schemas/resource-start';
import { arrowLinkSchema, graphLink, type PackGraphLink } from './pack-graph-link';
export { graphLink, type PackGraphLink } from './pack-graph-link';
import {
  workflowSourceSchema,
  type ResolvedWorkflow,
  type WorkflowLoadResult,
  type WorkflowSource,
  type WorkflowWithSource,
} from './schemas/workflow';
import { packDirectory, splitInstalledPackKey, type WorkflowSourceRoots } from './workflow-source';

const packGraphNodeSchema = z.object({
  /** The id the engine runs the node under: `<include>__<id>` for an included node. */
  id: z.string(),
  kind: z.string(),
  dependsOn: z.array(z.string()),
  /**
   * The loop group whose body the node is in, by that group's id here; null at the top of
   * the stage. A body node's `id` and `dependsOn` are step names, `<group>.<body id>`, the
   * names its runs are recorded under.
   */
  loopGroup: z.string().nullable(),
  /** The include blocks the node came from, outermost first; empty when the stage authored it. */
  blocks: z.array(z.object({ include: z.string(), workflow: z.string() })),
  /**
   * An `include:` with `fan_out:` stays one node, because its width is known only at run
   * time; `workflow` names its body in the graph's `fanOutBlocks`. Null for any other node.
   */
  fanOut: z.object({ workflow: z.string() }).nullable(),
  /** The node's `display:`, an included node's as its included workflow authored it. */
  display: nodeDisplaySchema.optional(),
});

const packGraphStageSchema = z.object({
  name: z.string(),
  /**
   * The stage's name within the pack: its authored `name:`, which a run of the stage
   * records as `pack.workflow` (`runPack`). Match a run to its stage by this and the pack key.
   */
  workflow: z.string(),
  /** A timer, event or fire binding of the pack starts the stage: work enters here. */
  entry: z.boolean(),
  /**
   * The roles the stage's nodes name: each `@alias` of a `model:` preference list, with the
   * tier or model the list ends in, which runs when no config defines the alias. The graph
   * does not resolve them: a binding's run config, the project and the install each may.
   */
  roles: z.array(z.object({ role: z.string(), fallback: z.string() })),
  /**
   * Work flows through the stage: it is an entry, or an arrow leads to or from it. False for
   * a workflow of the pack that only other workflows include or call, which no item stands at.
   * A stage that `observes` its item can be in flow: the arrows say where its runs sit in the
   * work, though an item's standing reads past them (`item-standing.ts`).
   */
  inFlow: z.boolean(),
  /** The returns node's id after include expansion, or null when the stage returns nothing. */
  returns: z.string().nullable(),
  outcome: z
    .object({
      field: z.string(),
      form: z.enum(['enum', 'boolean']),
      values: z.array(
        z.object({
          value: z.string(),
          /**
           * No active arrow without problems leaves this outcome. Whether that is a dead end
           * is the pack's call.
           */
          startsNothing: z.boolean(),
          /** The stage declares that this outcome finishes its item (`returns.ends`). */
          ends: z.boolean(),
          /**
           * A run that ends with this outcome and leaves no ask or wait stops its item
           * (`itemFate`): no active arrow without problems starts a step on the item itself
           * (a linked arrow starts on other items, and a stage that observes its item is no
           * step), it does not end the item, and the stage is a step. For a stage with `asks` or `waits`, it stops only when the run leaves
           * none.
           */
          stops: z.boolean(),
          /** The stage's `display.outcomes` entry for this value. */
          display: outcomeDisplaySchema.optional(),
        })
      ),
    })
    .nullable(),
  /**
   * The stage declares `observes: true`: its runs act on an item without being steps of it,
   * so none of its outcomes stops or ends the item.
   */
  observes: z.boolean(),
  /** The stage declares `result.asks`, so a run can end leaving questions on its item. */
  asks: z.boolean(),
  /** The stage declares `result.waits`, so a run can end leaving its item waiting on an event. */
  waits: z.boolean(),
  /** The options every ask of the stage offers (`stageAskOptions`), or null. */
  options: stageAskOptionsSchema,
  nodes: z.array(packGraphNodeSchema),
  /** The stage's `display:` without its outcomes'. Each `display` is absent, never null, when unset. */
  display: stageDisplaySchema.optional(),
});

/**
 * What starts an arrow: a run of `stage` completing with `outcome`, or the asks a run of
 * `stage` left being `settled` that way, and with `option`, answered choosing that option.
 */
const arrowFromSchema = z.union([
  z.object({ stage: z.string(), outcome: z.string() }),
  z.object({
    stage: z.string(),
    settled: asksSettledTriggerSchema.shape.settled,
    option: asksSettledTriggerSchema.shape.option,
  }),
]);
export type PackGraphArrowFrom = z.infer<typeof arrowFromSchema>;

const arrowEndsSchema = {
  from: arrowFromSchema,
  /** The workflow the arrow starts; it may be outside the pack. */
  to: z.string(),
  /** The link the arrow starts its stage over, or null when it starts on the ended run's own item. */
  linked: arrowLinkSchema.nullable(),
};
const declaredSourceSchema = z.object({
  binding: z.string(),
  /**
   * Why the binding cannot be read against the pack as it loaded: it names a workflow that
   * is not a stage here. The name is reported as declared; `discoveryErrors` says whether
   * that stage failed to load.
   */
  problems: z.array(z.string()),
});
const installedSourceSchema = z.object({
  file: z.string(),
  sourceInstanceId: z.string(),
  /**
   * What the check a run gets before it starts finds wrong with the file. Non-empty means
   * a run of `from.stage` on an item is refused before it starts, so the arrow starts nothing.
   */
  problems: z.array(z.string()),
});

/** An arrow is active exactly when a trigger file in this install launches it. */
const packGraphArrowSchema = z.discriminatedUnion('active', [
  z.object({
    ...arrowEndsSchema,
    active: z.literal(true),
    /** The pack binding it matches, or null for a trigger file the pack does not declare. */
    declared: declaredSourceSchema.nullable(),
    installed: installedSourceSchema,
  }),
  z.object({
    ...arrowEndsSchema,
    active: z.literal(false),
    declared: declaredSourceSchema,
    installed: z.null(),
  }),
]);

/** One copy of a pack that discovery reached: its scope, its key there, and where it is read from. */
export const packCopySchema = z.object({
  source: workflowSourceSchema,
  key: z.string(),
  /** Null for a bundled pack a compiled binary reads from its own embedded bytes. */
  dir: z.string().nullable(),
});
export type PackCopy = z.infer<typeof packCopySchema>;

/**
 * One setting the pack declares (`.pack/pack.yaml` `inputs:`) and what this project sets it
 * to. `value` is the project's own value from its settings file for the pack, null when it
 * sets none and the `default` applies. Values are text, as every workflow input is.
 */
const packGraphSettingSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  type: z.enum(['string', 'bool', 'list', 'enum']),
  default: z.string().nullable(),
  value: z.string().nullable(),
});

export const packGraphSchema = z.object({
  pack: z.string(),
  /**
   * The copies the graph was read from, nearest scope first: one, or several when a
   * project and a home pack folder share the key and their workflows are merged.
   */
  loaded: z.array(packCopySchema),
  /**
   * The other copies of the same pack in reach under another key, such as the installed
   * `<owner>.<name>` beside a project pack `<name>`. Naming that key reads that copy.
   */
  otherCopies: z.array(packCopySchema),
  /** In the order work flows through them: see `inFlowOrder`. */
  stages: z.array(packGraphStageSchema),
  /**
   * How work enters the pack: each timer, event or fire binding it declares, with the stage
   * it starts. The graph does not say whether this install serves one; `trigger check` does.
   */
  entries: z.array(
    z.object({ binding: z.string(), kind: z.enum(['timer', 'event', 'fire']), stage: z.string() })
  ),
  /**
   * The pack's document (manifest `document`, else `how-it-works.md`), with what is wrong
   * with it and its groups; null for a pack with neither. See `pack-document.ts`.
   */
  document: z
    .object({
      path: z.string(),
      problems: z.array(z.string()),
      /** The document's markdown after its frontmatter, as the pack wrote it. */
      text: z.string(),
      /** The frontmatter's `words`, as written; absent when it declares none. */
      words: packWordsSchema.optional(),
      /**
       * The frontmatter's `exit`, the stage items leave the flow by, by `workflow` name; absent
       * when it declares none or names a stage not in flow (see `problems`).
       */
      exit: z.string().optional(),
    })
    .nullable(),
  /**
   * The overview cards the pack declares in `.shared/metric-views.json`, with the plain
   * names it gives its metrics; null for a pack that declares none. A file that does not
   * read or validate has no cards and says why in `problem`. See `schemas/metric-view.ts`.
   */
  metricViews: z
    .object({
      names: z.record(z.string(), z.string()),
      cards: z.array(metricViewSchema),
      problem: z.string().nullable(),
    })
    .nullable(),
  /**
   * The document's groups for display: name, optional `blurb` and opaque `kind`, stages by
   * `workflow` name in order, each stage not `inFlow` or already grouped left out (see
   * `document.problems`). Empty when none is declared or the document does not read.
   */
  groups: z.array(packGroupSchema),
  /**
   * How much runs at once: each resource the pack's registered arrows start work on, with
   * the stages they start there. `declared` is the capacity those files name, null when
   * none does. `limit` is the capacity the slot recorded at its last start, which is what
   * admission applies, null for a slot nothing has started on. `held` is how many runs that have
   * not ended hold a slot now.
   */
  capacity: z.array(
    z.object({
      resource: z.string(),
      stages: z.array(z.string()),
      declared: z.number().int().nullable(),
      limit: z.number().int().nullable(),
      held: z.number().int(),
    })
  ),
  /** The pack's declared settings with this project's values, in declaration order. */
  settings: z.array(packGraphSettingSchema),
  /**
   * The project's settings file for the pack, as a path within the project, and what is
   * wrong with it: an unknown key or a value of the wrong type. It may not exist.
   */
  settingsFile: z.object({ path: z.string(), problems: z.array(z.string()) }),
  arrows: z.array(packGraphArrowSchema),
  /** The body of each fan-out include a stage or another body names, once per workflow. */
  fanOutBlocks: z.array(z.object({ workflow: z.string(), nodes: z.array(packGraphNodeSchema) })),
  /**
   * Every workflow that failed to load from the source the pack was read from. A failed
   * stage is missing from `stages`, so a non-empty list means the graph may be incomplete.
   */
  discoveryErrors: z.array(
    z.object({ filename: z.string(), workflowName: z.string().nullable(), error: z.string() })
  ),
});

export type PackGraph = z.infer<typeof packGraphSchema>;
export type PackGraphArrow = z.infer<typeof packGraphArrowSchema>;

/** Nearest scope first. A `Record` so a new workflow source cannot be left unranked. */
const SCOPE_RANK: Readonly<Record<WorkflowSource, number>> = {
  project: 0,
  global: 1,
  bundled: 2,
  installed: 3,
};

/** No dispatchable workflow of the pack was discovered; the message carries the discovery errors. */
export class PackNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackNotFoundError';
  }
}

/**
 * The pack name a key stands for: an installed key is `<owner>.<name>`, every other
 * scope's key is the pack folder's name.
 */
function packName(pack: { source: WorkflowSource; key: string }): string {
  return pack.source === 'installed'
    ? (splitInstalledPackKey(pack.key)?.name ?? pack.key)
    : pack.key;
}

/** Each distinct pack (scope and key) of the discovered workflows, nearest scope first. */
function discoveredPacks(
  discovered: WorkflowLoadResult
): { source: WorkflowSource; key: string }[] {
  const packs = new Map<string, { source: WorkflowSource; key: string }>();
  for (const { workflow } of [...discovered.workflows, ...(discovered.support ?? [])]) {
    if (workflow.pack === undefined) continue;
    const { source, key } = workflow.pack;
    packs.set(`${source}\0${key}`, { source, key });
  }
  return [...packs.values()].sort((a, b) => SCOPE_RANK[a.source] - SCOPE_RANK[b.source]);
}

/**
 * Every copy of the pack `packKey` names that discovery reached, split into the copies
 * read under `packKey` and the copies of the same pack name under another key. `roots`
 * are the roots discovery read, so each `dir` is where that copy's bytes come from.
 */
export async function packCopies(
  discovered: WorkflowLoadResult,
  roots: WorkflowSourceRoots,
  packKey: string
): Promise<{ loaded: PackCopy[]; otherCopies: PackCopy[] }> {
  const loaded: PackCopy[] = [];
  const otherCopies: PackCopy[] = [];
  const wanted = discoveredPacks(discovered).find(pack => pack.key === packKey);
  const name = wanted === undefined ? packKey : packName(wanted);
  for (const pack of discoveredPacks(discovered)) {
    if (packName(pack) !== name && pack.key !== packKey) continue;
    const embedded = pack.source === 'bundled' && roots.kind === 'live' && isBinaryBuild();
    const dir = embedded ? null : await packDirectory(roots, pack);
    if (dir === null && !embedded) continue;
    (pack.key === packKey ? loaded : otherCopies).push({ ...pack, dir });
  }
  return { loaded, otherCopies };
}

/** The pack's dispatchable workflows; none found throws `PackNotFoundError`. */
export function packWorkflows(
  discovered: WorkflowLoadResult,
  packKey: string,
  from: string
): readonly WorkflowWithSource[] {
  const workflows = discovered.workflows.filter(entry => entry.workflow.pack?.key === packKey);
  if (workflows.length === 0) {
    // The same pack under another key: a project pack folder is keyed by its name, the
    // installed copy by `<owner>.<name>`, and an author often types the other one.
    // `packKey` may be either spelling, so both readings of it are tried.
    const names = new Set([packKey, splitInstalledPackKey(packKey)?.name ?? packKey]);
    const elsewhere = discoveredPacks(discovered)
      .filter(pack => names.has(packName(pack)))
      .map(
        pack =>
          `Pack '${packName(pack)}' is in reach as '${pack.key}' (${pack.source}); name '${pack.key}' to use it.`
      );
    // An invalid declaration fails every workflow of its pack, so the reason is here.
    const errors = [...new Set(discovered.errors.map(e => `  ${e.filename}: ${e.error}`))];
    throw new PackNotFoundError(
      [
        `No workflow pack '${packKey}' was found from ${from}.`,
        ...elsewhere,
        ...errors.slice(0, 20),
      ].join('\n')
    );
  }
  return workflows;
}

/**
 * The bindings the pack declares, or undefined when it declares none. Pack folders of one
 * name in several scopes are one pack to a run, and the nearest scope's file wins there;
 * the nearest declaration wins here.
 */
export function nearestPackBindings(
  workflows: readonly WorkflowWithSource[]
): Readonly<Record<string, PackBinding>> | undefined {
  return declaringPack(workflows)?.bindings;
}

/** The nearest copy of the pack that declares bindings, whose declaration is the one that binds. */
export function declaringPack(workflows: readonly WorkflowWithSource[]) {
  return workflows
    .flatMap(({ workflow: { pack } }) => (pack?.bindings !== undefined ? [pack] : []))
    .sort((a, b) => SCOPE_RANK[a.source] - SCOPE_RANK[b.source])[0];
}

/**
 * The full name a workflow declared inside the pack has here. A binding names a stage as
 * its pack authored it (`plan`); an installed pack's stages are named `owner/plugin:plan`,
 * so the name gets the pack's own prefix, never another pack's. A name that is a stage, or
 * that names another pack outright, is kept as written.
 */
function qualifiedPackWorkflowName(names: readonly string[], declared: string): string {
  if (names.includes(declared) || declared.includes(':')) return declared;
  const first = names[0] ?? '';
  const separator = first.indexOf(':');
  return separator === -1 ? declared : `${first.slice(0, separator + 1)}${declared}`;
}

/** The stage a binding names, by its full name within the pack, or undefined when none. */
export function packWorkflowName(names: readonly string[], declared: string): string | undefined {
  const qualified = qualifiedPackWorkflowName(names, declared);
  return names.find(n => n === qualified);
}

/**
 * Whether the workflow's own pack declares a wake binding that takes the checkout a run of
 * this workflow leaves (`wake.checkout: waiting-run`) for one of the waits it leaves, by
 * name (`events`), as `resolveWake` matches a binding to a wait. Only then does a completion
 * that leaves waits record that checkout and keep its worktree; a run whose waits only
 * event-field wakes follow needs neither. A wake binding written into a source plugin's
 * config by hand, outside a pack, is not seen here, so its start is refused naming the
 * checkout the waiting run did not record.
 */
export function packWakeTakesCheckout(
  workflow: Pick<ResolvedWorkflow, 'name' | 'pack'>,
  events: readonly string[]
): boolean {
  return Object.values(workflow.pack?.bindings ?? {}).some(binding => {
    const kinded = kindedPackBinding(binding);
    const wake = kinded.kind === 'event' ? kinded.binding.wake : undefined;
    return (
      wake?.checkout !== undefined &&
      events.includes(wake.wait) &&
      packWorkflowName([workflow.name], wake.workflow) === workflow.name
    );
  });
}

/**
 * Every workflow name one binding declares: the workflow it starts, the run it follows,
 * the workflow whose run resets its limit, and the workflow it wakes. `archon pack bindings`
 * resolves each of these with `packWorkflowName`, so a field that names a workflow there
 * belongs here too.
 */
export function bindingWorkflowNames(binding: PackBinding): string[] {
  const kinded = kindedPackBinding(binding);
  const from = declaredFrom(binding);
  const wake = kinded.kind === 'event' ? kinded.binding.wake?.workflow : undefined;
  return [binding.workflow, from, binding.limit?.reset_on, wake].filter(
    (name): name is string => name !== undefined
  );
}

/**
 * Every full workflow name that belongs to the pack: its stages, and each name its
 * run-ended and asks-settled bindings declare, qualified within the pack, so a stage that
 * failed to load still counts. A trigger file touches the pack when one of its ends is in
 * this set, compared exactly, as a completion compares the ended run's workflow name.
 */
export function packWorkflowIdentities(
  stageNames: readonly string[],
  declared: Readonly<Record<string, PackBinding>> | undefined
): ReadonlySet<string> {
  const names = new Set(stageNames);
  for (const binding of Object.values(declared ?? {})) {
    const from = declaredFrom(binding);
    if (from === undefined) continue;
    for (const name of [from, binding.workflow])
      names.add(qualifiedPackWorkflowName(stageNames, name));
  }
  return names;
}

/** The workflow whose run starts a declared binding, or undefined for one no run starts. */
function declaredFrom(binding: PackBinding): string | undefined {
  const kinded = kindedPackBinding(binding);
  if (kinded.kind === 'run_ended') return kinded.binding.run_ended.workflow;
  if (kinded.kind === 'asks_settled') return kinded.binding.asks_settled.workflow;
  return undefined;
}

/**
 * A run-ended or asks-settled trigger file in this install whose binding launches in the
 * pack's project. `from.stage` is the workflow name as the file spells it.
 */
export interface InstalledArrow {
  file: string;
  sourceInstanceId: string;
  /** The resource the file's starts take a slot of, and the capacity it declares for it. */
  resource: string;
  capacity: number | null;
  from: PackGraphArrowFrom;
  launchWorkflow: string;
  /**
   * The link the file starts its stage over (`on.runEnded.linked`, see `graphLink`), or
   * null when it starts on the ended run's own item. It matches only a declared arrow with
   * the same link.
   */
  linked: PackGraphLink | null;
  problems: readonly string[];
  /**
   * The workflow the file starts, as its check resolved it, is a step of its item; false for
   * one that observes it (`observesItem`), whose start moves the item on not at all.
   */
  startsStep: boolean;
}

export type Stage = Pick<
  ResolvedWorkflow,
  'name' | 'returns' | 'result' | 'nodes' | 'pack' | 'observes' | 'display'
>;

interface GraphInput {
  packKey: string;
  stages: readonly Stage[];
  declared: Readonly<Record<string, PackBinding>> | undefined;
  installed: readonly InstalledArrow[];
  /** Every discovered workflow, stages included, where a fan-out include's body is found. */
  workflows: readonly Pick<Stage, 'name' | 'nodes'>[];
  discoveryErrors: WorkflowLoadResult['errors'];
}

/**
 * One key per arrow, as `runEndedTriggerCheck` keys a duplicate within a project. The kind
 * of origin is its own element, so an outcome spelled like a settlement never matches one.
 */
const arrowKey = (from: PackGraphArrowFrom, to: string): string =>
  JSON.stringify(
    'outcome' in from
      ? [from.stage, 'outcome', from.outcome, to]
      : [from.stage, 'settled', from.settled, from.option ?? null, to]
  );

const installedSource = (
  entry: InstalledArrow
): { file: string; sourceInstanceId: string; problems: string[] } => ({
  file: entry.file,
  sourceInstanceId: entry.sourceInstanceId,
  problems: [...entry.problems],
});

/**
 * Each declared run-ended binding as one arrow per outcome it lists, and each declared
 * asks-settled binding as one arrow per option it lists (one when it lists none), from
 * stage to stage. A workflow name that is not a stage is kept as declared, with a problem,
 * so a stage that failed to load leaves its arrows and the load error in the graph instead
 * of failing it.
 */
interface DeclaredArrow {
  binding: { binding: string; problems: string[] };
  from: PackGraphArrowFrom;
  to: string;
  linked: PackGraphLink | null;
}

// Which inputs read an entry is the file's input mapping, which never parts two arrows.
const sameLink = (a: PackGraphLink | null, b: PackGraphLink | null): boolean =>
  a === null || b === null
    ? a === b
    : a.kind === b.kind && a.holder === b.holder && a.items === b.items;

function declaredArrows(input: GraphInput): DeclaredArrow[] {
  const names = input.stages.map(stage => stage.name);
  return Object.entries(input.declared ?? {}).flatMap(([id, binding]): DeclaredArrow[] => {
    const kinded = kindedPackBinding(binding);
    if (kinded.kind !== 'run_ended' && kinded.kind !== 'asks_settled') return [];
    const problems: string[] = [];
    // A name that is not a stage keeps its full name in the pack, so a file for it matches.
    const stageName = (declared: string): string => {
      const name = packWorkflowName(names, declared);
      if (name !== undefined) return name;
      problems.push(
        `names workflow '${declared}', which is not a stage of pack '${input.packKey}' as it loaded; see discoveryErrors`
      );
      return qualifiedPackWorkflowName(names, declared);
    };
    if (kinded.kind === 'asks_settled') {
      const stage = stageName(kinded.binding.asks_settled.workflow);
      const to = stageName(kinded.binding.workflow);
      const { settled, option } = kinded.binding.asks_settled;
      const options =
        option === undefined ? [undefined] : typeof option === 'string' ? [option] : option;
      return options.map(value => ({
        binding: { binding: id, problems: [...problems] },
        from: { stage, settled, ...(value === undefined ? {} : { option: value }) },
        to,
        linked: null,
      }));
    }
    const stage = stageName(kinded.binding.run_ended.workflow);
    const to = stageName(kinded.binding.workflow);
    const { outcome, linked } = kinded.binding.run_ended;
    return (typeof outcome === 'string' ? [outcome] : outcome).map(value => ({
      binding: { binding: id, problems: [...problems] },
      from: { stage, outcome: value },
      to,
      linked: graphLink(linked, kinded.binding.inputs),
    }));
  });
}

/**
 * Every arrow: each declared one, active with each installed file that matches it or
 * inactive when none does, then each installed file the pack does not declare.
 */
function graphArrows(input: GraphInput): PackGraphArrow[] {
  const arrows: PackGraphArrow[] = [];
  const matched = new Set<InstalledArrow>();
  for (const { binding, from, to, linked } of declaredArrows(input)) {
    const ends = { from, to, linked };
    const files = input.installed.filter(
      entry =>
        sameLink(entry.linked, linked) &&
        arrowKey(entry.from, entry.launchWorkflow) === arrowKey(from, to)
    );
    if (files.length === 0)
      arrows.push({ ...ends, active: false, declared: binding, installed: null });
    // Two files for one arrow start the stage twice; each is reported, as `trigger check` does.
    for (const entry of files) {
      matched.add(entry);
      arrows.push({
        ...ends,
        // What the installed file maps is what its starts receive.
        linked: entry.linked,
        active: true,
        declared: binding,
        installed: installedSource(entry),
      });
    }
  }
  for (const entry of input.installed) {
    if (matched.has(entry)) continue;
    arrows.push({
      from: entry.from,
      to: entry.launchWorkflow,
      linked: entry.linked,
      active: true,
      declared: null,
      installed: installedSource(entry),
    });
  }
  return arrows;
}

/** Every `@alias` the nodes' model preference lists name, each once, with the list's last entry. */
function stageRoles(nodes: Stage['nodes']): PackGraph['stages'][number]['roles'] {
  const roles = new Map<string, { role: string; fallback: string }>();
  const visit = (list: Stage['nodes']): void => {
    for (const node of list) {
      const model = 'model' in node ? node.model : undefined;
      const fallback = Array.isArray(model) ? model.at(-1) : undefined;
      if (Array.isArray(model) && fallback !== undefined)
        for (const role of model.slice(0, -1))
          roles.set(`${role}\0${fallback}`, { role, fallback });
      if (isLoopGroupNode(node)) visit(resolvedBodyNodes(node.loop_group));
    }
  };
  visit(nodes);
  return [...roles.values()];
}

function graphStage(
  stage: Stage,
  started: ReadonlySet<string>,
  startedOnItem: ReadonlySet<string>,
  flow: { entries: ReadonlySet<string>; arrows: readonly PackGraphArrow[] }
): PackGraph['stages'][number] {
  const declared = declaredOutcome(stage);
  let outcome: PackGraph['stages'][number]['outcome'] = null;
  if (declared !== undefined) {
    const values = outcomeValues(declared.form);
    outcome = {
      field: declared.field,
      form: declared.form.kind,
      values: values.map(value => {
        const key = arrowKey({ stage: stage.name, outcome: value }, '');
        return {
          value,
          startsNothing: !started.has(key),
          ends: stage.result?.ends?.includes(value) === true,
          stops: declaredItemFate(stage, value, startedOnItem.has(key)) === 'stops',
          ...outcomeWords(stage.display, value),
        };
      }),
    };
  }
  return {
    name: stage.name,
    workflow: stage.pack?.workflow ?? stage.name,
    entry: flow.entries.has(stage.name),
    roles: stageRoles(stage.nodes),
    inFlow:
      flow.entries.has(stage.name) ||
      flow.arrows.some(arrow => arrow.from.stage === stage.name || arrow.to === stage.name),
    returns: stage.returns ?? null,
    outcome,
    observes: observesItem(stage),
    asks: stage.result?.asks !== undefined,
    waits: stage.result?.waits !== undefined,
    options: stageAskOptions(stage.result?.options),
    nodes: stageNodes(stage),
    ...stageDisplay(stage.display),
  };
}

/** The stages a timer, event or fire binding of the pack starts, in declaration order. */
function entryStages(input: GraphInput): string[] {
  const names = input.stages.map(stage => stage.name);
  return Object.values(input.declared ?? {}).flatMap(binding =>
    declaredFrom(binding) === undefined ? (packWorkflowName(names, binding.workflow) ?? []) : []
  );
}

/**
 * The stages in the order work flows through them, which the pack declares nowhere else:
 * breadth-first along the arrows that start work on the run's own item, from the stages the
 * pack's timer, event and fire bindings start, then from each stage no arrow (then only an
 * answer) leads to; then along linked arrows, which start work on other items, out of the stages
 * placed; then from any stage still unplaced. Arrows keep the order the pack declares them in.
 */
function inFlowOrder(input: GraphInput, arrows: readonly PackGraphArrow[]): Stage[] {
  const names = input.stages.map(stage => stage.name);
  const led = (outcomeOnly: boolean): string[] => {
    const to = arrows
      .filter(arrow => arrow.from.stage !== arrow.to && (!outcomeOnly || 'outcome' in arrow.from))
      .map(arrow => arrow.to);
    return names.filter(name => !to.includes(name));
  };
  const next = (s: string, all: boolean): string[] =>
    arrows
      .filter(a => a.from.stage === s && 'outcome' in a.from && (all || !a.linked))
      .map(a => a.to);
  const ordered = new Set<string>();
  const walk = (pending: string[], all: boolean): void => {
    for (let name = pending.shift(); name !== undefined; name = pending.shift()) {
      if (ordered.has(name) || !names.includes(name)) continue;
      ordered.add(name);
      pending.push(...next(name, all));
    }
  };
  for (const root of [...entryStages(input), ...led(false), ...led(true)]) walk([root], false);
  walk(Array.from(ordered, name => next(name, true)).flat(), true);
  for (const root of names) walk([root], true);
  return [...ordered].flatMap(name => input.stages.find(stage => stage.name === name) ?? []);
}

/**
 * The graph of one pack from its stages (include-expanded), its declared bindings and the
 * install's run-ended and asks-settled files for its project. Which copies of the pack it
 * was read from is `packCopies`' answer, added by the reader that has the source roots.
 */
export function buildPackGraph(
  input: GraphInput
): Omit<
  PackGraph,
  | 'loaded'
  | 'otherCopies'
  | 'document'
  | 'metricViews'
  | 'groups'
  | 'settings'
  | 'settingsFile'
  | 'capacity'
> {
  const arrows = graphArrows(input);
  // Only an outcome arrow starts something for an outcome; an asks arrow starts on answers.
  const usable = arrows.filter(arrow => arrow.active && arrow.installed.problems.length === 0);
  const started = new Set(usable.map(arrow => arrowKey(arrow.from, '')));
  // What an installed file starts is its check's resolution, not a guess from the stages.
  const startedOnItem = itemStepStarts(
    input.installed.filter(entry => entry.problems.length === 0)
  );
  const flow = { entries: new Set(entryStages(input)), arrows };
  const staged = inFlowOrder(input, arrows).map(stage =>
    graphStage(stage, started, startedOnItem, flow)
  );
  return {
    pack: input.packKey,
    entries: Object.entries(input.declared ?? {}).flatMap(([binding, declared]) => {
      const { kind } = kindedPackBinding(declared);
      if (kind === 'run_ended' || kind === 'asks_settled') return [];
      const names = input.stages.map(stage => stage.name);
      return [
        { binding, kind, stage: packWorkflowName(names, declared.workflow) ?? declared.workflow },
      ];
    }),
    // The workflows no item stands at come after the stages work flows through.
    stages: [true, false].flatMap(inFlow => staged.filter(stage => stage.inFlow === inFlow)),
    arrows,
    fanOutBlocks: fanOutBlocks(input.stages, input.workflows),
    discoveryErrors: input.discoveryErrors.map(e => ({
      filename: e.filename,
      workflowName: e.workflowName ?? null,
      error: e.error,
    })),
  };
}

/**
 * The outcomes the arrows start a step on for the ended run's own item, keyed as `arrowKey`,
 * from each arrow's `startsStep`. A linked arrow starts on other items and moves nothing here.
 */
function itemStepStarts(
  arrows: readonly { from: PackGraphArrowFrom; linked: PackGraphLink | null; startsStep: boolean }[]
): Set<string> {
  return new Set(
    arrows
      .filter(arrow => 'outcome' in arrow.from && arrow.linked === null && arrow.startsStep)
      .map(arrow => arrowKey(arrow.from, ''))
  );
}

/** An outcome of a stage that stops its item; `unless` names what the run can leave instead. */
export interface DeclaredStop {
  stage: string;
  outcome: string;
  unless: ('asks' | 'waits')[];
}

/**
 * The outcomes of `stages` that stop their item when only the bindings declared beside them
 * start stages (`declaredItemFate`): what `archon validate workflows` reports before anything
 * is installed. A declared binding counts when it names stages that loaded and starts a step
 * on the ended run's own item, as the pack graph counts an installed one. With no declaration (a
 * workflow outside a pack) nothing starts. An installed trigger file is `archon trigger
 * check`'s to read.
 */
export function declaredStops(
  packKey: string,
  stages: readonly Stage[],
  declared: Readonly<Record<string, PackBinding>> | undefined
): DeclaredStop[] {
  // A declaration names a stage of the pack, or a workflow outside it, taken to be a step.
  const observing = new Set(stages.filter(observesItem).map(stage => stage.name));
  const bound = itemStepStarts(
    declaredArrows({
      packKey,
      stages,
      declared,
      installed: [],
      workflows: [],
      discoveryErrors: [],
    })
      .filter(arrow => arrow.binding.problems.length === 0)
      .map(arrow => ({ ...arrow, startsStep: !observing.has(arrow.to) }))
  );
  return stages.flatMap(stage => {
    const outcome = declaredOutcome(stage);
    if (outcome === undefined) return [];
    const unless = [
      ...(stage.result?.asks !== undefined ? (['asks'] as const) : []),
      ...(stage.result?.waits !== undefined ? (['waits'] as const) : []),
    ];
    return outcomeValues(outcome.form)
      .filter(value => {
        const starts = bound.has(arrowKey({ stage: stage.name, outcome: value }, ''));
        return declaredItemFate(stage, value, starts) === 'stops';
      })
      .map(value => ({ stage: stage.name, outcome: value, unless }));
  });
}
