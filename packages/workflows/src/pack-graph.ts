/**
 * A pack's stage graph as this install has it: its stages, the outcomes each can end
 * with, each stage's nodes and their edges, and the run-ended arrows between stages, each
 * marked active (a trigger file in the install launches it) or declared and inactive (the
 * pack's `.pack/pack.yaml` declares it and no file does). It reports only what the engine
 * already reads: no arrow is declared here.
 *
 * `archon pack graph` and `GET /api/packs/{pack}/graph` return this one shape. An item's
 * path through the stages is the item read (`readItem`): each run's workflow is a stage,
 * and a `run_ended` cause names the run that ended and the arrow (`sourceInstanceId`) that
 * started the next.
 */
import { z } from 'zod';
import { declaredOutcome } from './completed-outcome';
import { readComposedMeta } from './compiled-command';
import type { PackBinding } from './schemas/pack-bindings';
import { kindedPackBinding } from './schemas/pack-bindings';
import { loopBodyStepNamePrefix, resolvedBodyNodes } from './graph-plan';
import { isComposeFanOutNode, isLoopGroupNode } from './schemas/node-guards';
import type { RunEndedTrigger } from './schemas/resource-start';
import type {
  ResolvedWorkflow,
  WorkflowLoadResult,
  WorkflowSource,
  WorkflowWithSource,
} from './schemas/workflow';

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

const arrowEndsSchema = {
  from: z.object({ stage: z.string(), outcome: z.string() }),
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

export const packGraphSchema = z.object({
  pack: z.string(),
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

/** The pack's dispatchable workflows; none found throws `PackNotFoundError`. */
export function packWorkflows(
  discovered: WorkflowLoadResult,
  packKey: string,
  from: string
): readonly WorkflowWithSource[] {
  const workflows = discovered.workflows.filter(entry => entry.workflow.pack?.key === packKey);
  if (workflows.length === 0) {
    // An invalid declaration fails every workflow of its pack, so the reason is here.
    const errors = [...new Set(discovered.errors.map(e => `  ${e.filename}: ${e.error}`))];
    throw new PackNotFoundError(
      [`No workflow pack '${packKey}' was found from ${from}.`, ...errors.slice(0, 20)].join('\n')
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

/** The workflow names the pack's run-ended bindings declare, as written. */
export function declaredRunEndedWorkflows(
  declared: Readonly<Record<string, PackBinding>> | undefined
): string[] {
  return Object.values(declared ?? {}).flatMap(binding => {
    const kinded = kindedPackBinding(binding);
    return kinded.kind === 'run_ended'
      ? [kinded.binding.run_ended.workflow, kinded.binding.workflow]
      : [];
  });
}

/** An installed pack's workflow is named `owner/plugin:<name>`; a binding may name `<name>`. */
export function packWorkflowName(names: readonly string[], declared: string): string | undefined {
  return names.find(n => n === declared || n.endsWith(`:${declared}`));
}

/** A run-ended trigger file in this install whose binding launches in the pack's project. */
export interface InstalledArrow {
  file: string;
  sourceInstanceId: string;
  runEnded: RunEndedTrigger;
  launchWorkflow: string;
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
    const body =
      workflows.find(w => w.name === name) ?? workflows.find(w => w.name.endsWith(`:${name}`));
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

/** One key per arrow, as `runEndedTriggerCheck` keys a duplicate within a project. */
const arrowKey = (from: string, outcome: string, to: string): string =>
  JSON.stringify([from, outcome, to]);

const installedSource = (
  entry: InstalledArrow
): { file: string; sourceInstanceId: string; problems: string[] } => ({
  file: entry.file,
  sourceInstanceId: entry.sourceInstanceId,
  problems: [...entry.problems],
});

/** Each declared run-ended binding as one arrow per outcome it lists, from stage to stage. */
/**
 * Each declared run-ended binding as one arrow per outcome it lists, from stage to stage.
 * A workflow name that is not a stage is kept as declared, with a problem, so a stage that
 * failed to load leaves its arrows and the load error in the graph instead of failing it.
 */
function declaredArrows(input: GraphInput): {
  binding: { binding: string; problems: string[] };
  from: string;
  outcome: string;
  to: string;
}[] {
  const names = input.stages.map(stage => stage.name);
  return Object.entries(input.declared ?? {}).flatMap(([id, binding]) => {
    const kinded = kindedPackBinding(binding);
    if (kinded.kind !== 'run_ended') return [];
    const problems: string[] = [];
    const stageName = (declared: string): string => {
      const name = packWorkflowName(names, declared);
      if (name !== undefined) return name;
      problems.push(
        `names workflow '${declared}', which is not a stage of pack '${input.packKey}' as it loaded; see discoveryErrors`
      );
      return declared;
    };
    const from = stageName(kinded.binding.run_ended.workflow);
    const to = stageName(kinded.binding.workflow);
    const { outcome } = kinded.binding.run_ended;
    return (typeof outcome === 'string' ? [outcome] : outcome).map(value => ({
      binding: { binding: id, problems: [...problems] },
      from,
      outcome: value,
      to,
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
  for (const { binding, from, outcome, to } of declaredArrows(input)) {
    const ends = { from: { stage: from, outcome }, to };
    const files = input.installed.filter(
      entry =>
        arrowKey(entry.runEnded.workflowName, entry.runEnded.outcome, entry.launchWorkflow) ===
        arrowKey(from, outcome, to)
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
      from: { stage: entry.runEnded.workflowName, outcome: entry.runEnded.outcome },
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
    const values = declared.form.kind === 'enum' ? declared.form.values : ['succeeded', 'failed'];
    outcome = {
      field: declared.field,
      form: declared.form.kind,
      values: values.map(value => ({
        value,
        startsNothing: !started.has(arrowKey(stage.name, value, '')),
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
 * install's run-ended files for its project.
 */
export function buildPackGraph(input: GraphInput): PackGraph {
  const arrows = graphArrows(input);
  const started = new Set(
    arrows
      .filter(arrow => arrow.active && arrow.installed.problems.length === 0)
      .map(arrow => arrowKey(arrow.from.stage, arrow.from.outcome, ''))
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
