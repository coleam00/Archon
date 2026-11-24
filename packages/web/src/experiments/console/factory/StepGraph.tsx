import { useMemo, type CSSProperties, type ReactElement } from 'react';
import { useNavigate } from 'react-router';
import { displayKeyOf } from './lib/work-orders';
import type { StepGraph as StepGraphData, StepGraphNode } from './lib/step-graph';
import {
  layoutStepGraph,
  STEP_GRAPH_PADDING,
  STEP_H,
  STEP_W,
  type LaidOutGroup,
  type LaidOutStep,
} from './lib/step-graph-layout';
import type { ItemOnStep } from './lib/items-on-step';
import { stepPagePath, type StepPageState } from './lib/stage-steps';
import { engineIdTitle } from './lib/step-label';
import { StepTags } from './StepTags';
import { toneColor } from './tones';

interface StepGraphProps {
  projectId: string;
  /** The workflow as the factory view names it; the step page's route takes this name. */
  workflow: string;
  /** The stage drawing this graph; the step page leads back to it. */
  stageId: string;
  graph: StepGraphData;
  /** The items on each step now, keyed by step key or loop id; nothing glows without it. */
  running?: ReadonlyMap<string, readonly ItemOnStep[]>;
}

const NOT_RUNNING: readonly ItemOnStep[] = [];

/** The canvas's padding and border around the laid-out graph, in px. */
const CANVAS_PAD_PX = 16;
const CANVAS_BORDER_PX = 1;

/**
 * RunGraphPanel's running tint, held still: the items read carries no owner liveness, so a
 * pulse would claim more than it knows. Its values are theme.css's running-mark tokens, which
 * the stage drill-down's cards wear too.
 */
export const RUNNING_GLOW: CSSProperties = {
  background: 'var(--running-fill)',
  borderColor: 'var(--running-border)',
  boxShadow: 'var(--running-ring)',
};

function runningFor(onStep: readonly ItemOnStep[]): string {
  return `Running for ${onStep.map(({ item }) => displayKeyOf(item)).join(', ')}`;
}

/**
 * One workflow's steps, top to bottom (RunGraphPanel's canvas, nodes and connectors), with
 * each loop group framed and labelled with its rounds and each included workflow framed in
 * dashes. Every step is drawn at full strength (owner change 4 of 2026-11-21): the open stage's
 * own steps carry a ring in its group's colour, and each step's tag names the stage that works
 * it (`StepTags`). A running step, or a loop between its bodies, glows whichever stage works
 * it. Clicking a step opens its page.
 */
export function StepGraph({
  projectId,
  workflow,
  stageId,
  graph,
  running,
}: StepGraphProps): ReactElement {
  const navigate = useNavigate();
  const laid = useMemo(() => layoutStepGraph(graph), [graph]);
  const size = {
    width: Math.max(laid.width, STEP_W + STEP_GRAPH_PADDING * 2),
    height: Math.max(laid.height, STEP_H + STEP_GRAPH_PADDING * 2),
  };
  return (
    <div
      // Not justify-center: a graph wider than the box would overflow to the left, out of
      // reach of the scrollbar. mx-auto centres it when it fits.
      className="w-full overflow-auto rounded-console-12 border-border"
      style={{
        padding: CANVAS_PAD_PX,
        borderWidth: CANVAS_BORDER_PX,
        // Dotted canvas, as RunGraphPanel draws it.
        background:
          'radial-gradient(circle at 1px 1px, color-mix(in oklch, white, transparent 95%) 1px, transparent 0) 0 0 / 26px 26px',
      }}
    >
      <div className="relative mx-auto" style={size}>
        {/* Under the frames, so a frame's label stays readable where an edge crosses it. */}
        <svg
          className="absolute inset-0 overflow-visible"
          width={size.width}
          height={size.height}
          aria-hidden
        >
          {laid.edges.map(edge => (
            <path
              key={`${edge.from}→${edge.to}`}
              d={edge.d}
              fill="none"
              stroke="color-mix(in oklch, white, transparent 84%)"
              strokeWidth={1.5}
            />
          ))}
        </svg>
        {laid.groups.map(group => (
          <GroupFrame
            key={group.group.id}
            group={group}
            onStep={running?.get(group.group.id) ?? NOT_RUNNING}
          />
        ))}
        {laid.steps.map(step => (
          <StepButton
            key={step.node.key}
            step={step}
            onStep={running?.get(step.node.key) ?? NOT_RUNNING}
            onOpen={() => {
              void navigate(stepPagePath(projectId, workflow, step.node.key), {
                state: { fromStage: stageId } satisfies StepPageState,
              });
            }}
          />
        ))}
        <StepTags projectId={projectId} steps={laid.steps} />
      </div>
    </div>
  );
}

function GroupFrame({
  group,
  onStep,
}: {
  group: LaidOutGroup;
  onStep: readonly ItemOnStep[];
}): ReactElement {
  const loop = group.group.kind === 'loop';
  // Only a loop is ever the running step: between its bodies, the deepest step is the loop.
  const glows = loop && onStep.length > 0;
  return (
    <div
      data-running={glows ? '' : undefined}
      title={glows ? runningFor(onStep) : undefined}
      className={`absolute rounded-console-12 border ${
        loop ? 'border-border-bright' : 'border-dashed border-border-bright'
      }`}
      style={{
        left: group.x,
        top: group.y,
        width: group.width,
        height: group.height,
        ...(glows ? { borderColor: RUNNING_GLOW.borderColor } : {}),
      }}
    >
      <div
        // A label wider than a narrow frame runs past its edge on its backing rather than cut
        // off the condition, which must read without hovering.
        className="relative ml-1.5 mt-1 inline-flex items-baseline gap-1.5 whitespace-nowrap rounded bg-surface px-1 text-console-12"
        title={group.group.when === null ? undefined : `Runs when ${group.group.when}`}
      >
        {loop ? (
          <>
            <span className="shrink-0 whitespace-nowrap font-medium text-text-secondary">
              up to {String(group.group.maxRounds ?? 1)} rounds
            </span>
            <span className="shrink-0 text-text-tertiary" title={group.group.id}>
              {group.group.label}
            </span>
            {group.group.condition === null ? null : (
              <span className="font-medium text-text-primary">{group.group.condition}</span>
            )}
          </>
        ) : (
          <>
            <span className="font-mono text-text-secondary">{group.group.label}</span>
            <span className="text-text-tertiary">included</span>
          </>
        )}
      </div>
    </div>
  );
}

function kindGlyph(kind: StepGraphNode['kind']): string {
  switch (kind) {
    case 'agent':
      return '·';
    case 'bash':
      return '$';
    case 'script':
      return '⧉';
    case 'loop':
      return '↻';
    case 'approval':
      return '◈';
    case 'wait':
      return '◷';
    case 'other':
      return '◇';
  }
}

function StepButton({
  step,
  onStep,
  onOpen,
}: {
  step: LaidOutStep;
  onStep: readonly ItemOnStep[];
  onOpen: () => void;
}): ReactElement {
  const { node } = step;
  const glows = onStep.length > 0;
  const { worker } = node;
  // The name in full, as the box may cut it, then the engine id.
  const title = [
    engineIdTitle(node.label, node.key),
    // The box may cut its condition line too; the worded condition, then the expression.
    ...(node.condition === null ? [] : [node.condition]),
    ...(node.when === null ? [] : [`Runs when ${node.when}`]),
    ...(glows ? [runningFor(onStep)] : []),
  ].join('\n');
  return (
    <button
      type="button"
      onClick={onOpen}
      data-running={glows ? '' : undefined}
      // Its hover border and lift are theme.css's `[data-step-node]:hover`.
      data-step-node=""
      title={title}
      data-worker={worker.kind}
      className="absolute flex cursor-pointer items-center gap-2.5 overflow-hidden rounded-lg border border-border-bright bg-surface-elevated px-3.5 text-left transition-colors duration-150 ease-out hover:bg-surface-hover"
      style={{
        left: step.x,
        top: step.y,
        width: step.width,
        height: step.height,
        ...(glows ? RUNNING_GLOW : {}),
        // An outline, not a shadow, so it composes with the running glow's ring.
        ...(worker.kind === 'this'
          ? { outline: `2px solid ${toneColor(worker.stage.group)}`, outlineOffset: 2 }
          : {}),
      }}
    >
      <span
        aria-hidden
        className="shrink-0 font-mono text-console-15 font-bold leading-none text-text-tertiary"
      >
        {kindGlyph(node.kind)}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-console-13 font-semibold text-text-primary">
          {node.label}
        </span>
        {node.condition === null ? null : (
          <span className="truncate text-console-12 text-text-secondary">{node.condition}</span>
        )}
      </span>
    </button>
  );
}
