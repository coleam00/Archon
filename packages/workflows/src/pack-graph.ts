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
  /** The include blocks the node came from, outermost first; empty when the stage authored it. */
  blocks: z.array(z.object({ include: z.string(), workflow: z.string() })),
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
          /** No active arrow leaves this outcome. Whether that is a dead end is the pack's call. */
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
const declaredSourceSchema = z.object({ binding: z.string() });
const installedSourceSchema = z.object({ file: z.string(), sourceInstanceId: z.string() });

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
}

type Stage = Pick<ResolvedWorkflow, 'name' | 'returns' | 'result' | 'nodes'>;

function stageNodes(stage: Stage): PackGraph['stages'][number]['nodes'] {
  return stage.nodes.map(node => ({
    id: node.id,
    kind: node.kind,
    dependsOn: [...(node.depends_on ?? [])],
    blocks: (readComposedMeta(node)?.boundaries ?? []).map(({ boundary }) => ({
      include: boundary.includeId,
      workflow: boundary.workflow,
    })),
  }));
}

interface GraphInput {
  packKey: string;
  stages: readonly Stage[];
  declared: Readonly<Record<string, PackBinding>> | undefined;
  installed: readonly InstalledArrow[];
}

/** One key per arrow, as `runEndedTriggerCheck` keys a duplicate within a project. */
const arrowKey = (from: string, outcome: string, to: string): string =>
  JSON.stringify([from, outcome, to]);

const installedSource = (entry: InstalledArrow): { file: string; sourceInstanceId: string } => ({
  file: entry.file,
  sourceInstanceId: entry.sourceInstanceId,
});

/** Each declared run-ended binding as one arrow per outcome it lists, from stage to stage. */
function declaredArrows(
  input: GraphInput
): { binding: string; from: string; outcome: string; to: string }[] {
  const names = input.stages.map(stage => stage.name);
  const stageName = (id: string, declared: string): string => {
    const name = packWorkflowName(names, declared);
    if (name === undefined)
      throw new Error(
        `Binding '${id}' names workflow '${declared}', which pack '${input.packKey}' does not provide.`
      );
    return name;
  };
  return Object.entries(input.declared ?? {}).flatMap(([id, binding]) => {
    const kinded = kindedPackBinding(binding);
    if (kinded.kind !== 'run_ended') return [];
    const from = stageName(id, kinded.binding.run_ended.workflow);
    const to = stageName(id, kinded.binding.workflow);
    const { outcome } = kinded.binding.run_ended;
    return (typeof outcome === 'string' ? [outcome] : outcome).map(value => ({
      binding: id,
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
      arrows.push({ ...ends, active: false, declared: { binding }, installed: null });
    // Two files for one arrow start the stage twice; each is reported, as `trigger check` does.
    for (const entry of files) {
      matched.add(entry);
      arrows.push({
        ...ends,
        active: true,
        declared: { binding },
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
 * install's run-ended files for its project. A declared run-ended binding that names a
 * workflow the pack does not provide throws, as `archon pack bindings` refuses it.
 */
export function buildPackGraph(input: GraphInput): PackGraph {
  const arrows = graphArrows(input);
  const started = new Set(
    arrows
      .filter(arrow => arrow.active)
      .map(arrow => arrowKey(arrow.from.stage, arrow.from.outcome, ''))
  );
  return {
    pack: input.packKey,
    stages: input.stages.map(stage => graphStage(stage, started)),
    arrows,
  };
}
