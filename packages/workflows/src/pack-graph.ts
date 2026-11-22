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
import { z } from 'zod';
import { declaredOutcome, outcomeValues } from './completed-outcome';
import { readComposedMeta } from './compiled-command';
import type { PackBinding } from './schemas/pack-bindings';
import { kindedPackBinding } from './schemas/pack-bindings';
import { loopBodyStepNamePrefix, resolvedBodyNodes } from './graph-plan';
import { isComposeFanOutNode, isLoopGroupNode } from './schemas/node-guards';
import { isBinaryBuild } from './defaults/bundled-defaults';
import { asksSettledTriggerSchema, type RunEndedLinked } from './schemas/resource-start';
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
});

const packGraphStageSchema = z.object({
  name: z.string(),
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
        })
      ),
    })
    .nullable(),
  /** The stage declares `result.asks`, so a run can end leaving questions on its item. */
  asks: z.boolean(),
  nodes: z.array(packGraphNodeSchema),
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
  stages: z.array(packGraphStageSchema),
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
  return workflows
    .flatMap(({ workflow: { pack } }) => (pack?.bindings !== undefined ? [pack] : []))
    .sort((a, b) => SCOPE_RANK[a.source] - SCOPE_RANK[b.source])[0]?.bindings;
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
  from: PackGraphArrowFrom;
  launchWorkflow: string;
  /**
   * The link the file starts its stage over (`on.runEnded.linked`), or null when it starts
   * on the ended run's own item. It matches only a declared arrow with the same link.
   */
  linked: RunEndedLinked | null;
  problems: readonly string[];
}

type Stage = Pick<ResolvedWorkflow, 'name' | 'returns' | 'result' | 'nodes'>;
type GraphNode = PackGraph['stages'][number]['nodes'][number];

/**
 * A stage's nodes, with each loop group's body after the group, recursively. Body nodes
 * take the step names the engine runs them under (`loopBodyStepNamePrefix`).
 */
function stageNodes(stage: Pick<Stage, 'nodes'>, group: string | null = null): GraphNode[] {
  const prefix = group === null ? '' : loopBodyStepNamePrefix(group);
  return stage.nodes.flatMap(node => {
    const id = prefix + node.id;
    const graphNode: GraphNode = {
      id,
      kind: node.kind,
      // The loader checks a body node's `depends_on` against its own body, so every one is a sibling.
      dependsOn: (node.depends_on ?? []).map(dep => prefix + dep),
      loopGroup: group,
      blocks: (readComposedMeta(node)?.boundaries ?? []).map(({ boundary }) => ({
        include: boundary.includeId,
        workflow: boundary.workflow,
      })),
      fanOut: isComposeFanOutNode(node) ? { workflow: node.include } : null,
    };
    return isLoopGroupNode(node)
      ? [graphNode, ...stageNodes({ nodes: resolvedBodyNodes(node.loop_group) }, id)]
      : [graphNode];
  });
}

/**
 * The body of every fan-out include reachable from the stages, resolved by name among
 * `workflows` as discovery resolved it, and the bodies those bodies fan out to.
 */
function fanOutBlocks(
  stages: readonly Pick<Stage, 'nodes'>[],
  workflows: readonly Pick<Stage, 'name' | 'nodes'>[]
): PackGraph['fanOutBlocks'] {
  const blocks: PackGraph['fanOutBlocks'] = [];
  const pending = stages.flatMap(stage => stageNodes(stage));
  for (let node = pending.shift(); node !== undefined; node = pending.shift()) {
    const name = node.fanOut?.workflow;
    if (name === undefined || blocks.some(block => block.workflow === name)) continue;
    // Discovery has already qualified an installed pack's include to its own full name.
    const body = workflows.find(w => w.name === name);
    // Discovery refuses a fan-out whose target does not resolve, so this is a caller's bug.
    if (body === undefined)
      throw new Error(`Fan-out include '${name}' is not a discovered workflow`);
    const nodes = stageNodes(body);
    blocks.push({ workflow: name, nodes });
    pending.push(...nodes);
  }
  return blocks;
}

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
  linked: RunEndedLinked | null;
}

const sameLink = (a: RunEndedLinked | null, b: RunEndedLinked | null): boolean =>
  a === null || b === null ? a === b : a.kind === b.kind && a.holder === b.holder;

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
      linked: linked ?? null,
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
    const ends = { from, to };
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
      active: true,
      declared: null,
      installed: installedSource(entry),
    });
  }
  return arrows;
}

function graphStage(stage: Stage, started: ReadonlySet<string>): PackGraph['stages'][number] {
  const declared = declaredOutcome(stage);
  let outcome: PackGraph['stages'][number]['outcome'] = null;
  if (declared !== undefined) {
    const values = outcomeValues(declared.form);
    outcome = {
      field: declared.field,
      form: declared.form.kind,
      values: values.map(value => ({
        value,
        startsNothing: !started.has(arrowKey({ stage: stage.name, outcome: value }, '')),
      })),
    };
  }
  return {
    name: stage.name,
    returns: stage.returns ?? null,
    outcome,
    asks: stage.result?.asks !== undefined,
    nodes: stageNodes(stage),
  };
}

/**
 * The graph of one pack from its stages (include-expanded), its declared bindings and the
 * install's run-ended and asks-settled files for its project. Which copies of the pack it
 * was read from is `packCopies`' answer, added by the reader that has the source roots.
 */
export function buildPackGraph(input: GraphInput): Omit<PackGraph, 'loaded' | 'otherCopies'> {
  const arrows = graphArrows(input);
  // Only an outcome arrow starts something for an outcome; an asks arrow starts on answers.
  const started = new Set(
    arrows
      .filter(arrow => arrow.active && arrow.installed.problems.length === 0)
      .map(arrow => arrowKey(arrow.from, ''))
  );
  return {
    pack: input.packKey,
    stages: input.stages.map(stage => graphStage(stage, started)),
    arrows,
    fanOutBlocks: fanOutBlocks(input.stages, input.workflows),
    discoveryErrors: input.discoveryErrors.map(e => ({
      filename: e.filename,
      workflowName: e.workflowName ?? null,
      error: e.error,
    })),
  };
}
