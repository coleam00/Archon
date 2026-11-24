import type { CSSProperties, ReactElement } from 'react';
import { Link } from 'react-router';
import type { FactoryWorkflow } from '../../skills/factory';
import { Panel, type ToneColor } from '../document';
import { stepPagePath, type StepPageState } from '../lib/stage-steps';
import { loopWords } from '../lib/step-facts';
import { KIND_TONES } from '../lib/step-kinds';

type Group = FactoryWorkflow['groups'][number];

/** One row of the drawing: a group's label, or a step. */
type Row =
  | { kind: 'group'; group: Group; depth: number }
  | { kind: 'step'; step: FactoryWorkflow['steps'][number]; depth: number };

/**
 * The steps in definition order (the read's order), each loop opening once above
 * its first step, at its depth.
 */
function workflowRows(workflow: FactoryWorkflow): Row[] {
  const groups = new Map(workflow.groups.map(group => [group.id, group]));
  const opened = new Set<string>();
  const chain = (id: string | null): Group[] => {
    const out: Group[] = [];
    for (let at = id; at !== null; at = groups.get(at)?.parent ?? null) {
      const group = groups.get(at);
      if (group === undefined) break;
      out.unshift(group);
    }
    return out;
  };
  const rows: Row[] = [];
  for (const step of workflow.steps) {
    // Only loops frame steps here: an include usually holds one step its name already says.
    const around = chain(step.group).filter(group => group.kind === 'loop');
    around.forEach((group, depth) => {
      if (opened.has(group.id)) return;
      opened.add(group.id);
      rows.push({ kind: 'group', group, depth });
    });
    rows.push({ kind: 'step', step, depth: around.length });
  }
  return rows;
}

const indent = (depth: number): CSSProperties => ({
  paddingLeft: `${(depth * 0.875).toString()}rem`,
});

/**
 * A small drawing of the step's workflow (owner change 7 of 2026-11-21): every step down one line,
 * in its kind's colour, indented inside its loops. This step is marked and is no
 * link; every other step opens its own step page, carrying the stage the page was opened from.
 */
export function StepWorkflowList({
  projectId,
  workflow,
  current,
  stepName,
  fromStage,
}: {
  projectId: string;
  workflow: FactoryWorkflow;
  current: string;
  stepName: (key: string) => string;
  fromStage: string | undefined;
}): ReactElement {
  const state: StepPageState | undefined = fromStage === undefined ? undefined : { fromStage };
  return (
    <Panel className="px-3 py-3">
      <ol aria-label={`The steps of ${workflow.name}`} className="flex flex-col gap-0.5">
        {workflowRows(workflow).map(row =>
          row.kind === 'group' ? (
            <li
              key={`group:${row.group.id}`}
              style={indent(row.depth)}
              className="pt-1.5 text-console-12 font-medium uppercase tracking-console-label text-text-tertiary"
            >
              {loopWords(row.group.label, row.group.maxRounds)}
            </li>
          ) : (
            <li key={row.step.key} style={indent(row.depth)} className="min-w-0">
              <StepRow
                name={stepName(row.step.key)}
                stepKey={row.step.key}
                tone={KIND_TONES[row.step.kind]}
                to={
                  row.step.key === current
                    ? null
                    : stepPagePath(projectId, workflow.name, row.step.key)
                }
                state={state}
              />
            </li>
          )
        )}
      </ol>
    </Panel>
  );
}

function StepRow({
  name,
  stepKey,
  tone,
  to,
  state,
}: {
  name: string;
  stepKey: string;
  tone: ToneColor;
  /** Null for this step, which is marked instead of linked. */
  to: string | null;
  state: StepPageState | undefined;
}): ReactElement {
  const dot = (
    <span
      aria-hidden="true"
      className="size-2 shrink-0 self-center rounded-full bg-[color:var(--doc-tone)]"
    />
  );
  const toned = { '--doc-tone': tone } as CSSProperties;
  if (to === null)
    return (
      <span
        aria-current="page"
        data-this-step=""
        className="flex min-w-0 items-baseline gap-2 rounded-md bg-surface-inset px-2 py-1 text-console-13 font-semibold text-text-primary ring-1 ring-inset ring-[color:var(--doc-tone)]"
        style={toned}
      >
        {dot}
        <span className="min-w-0 [overflow-wrap:anywhere]">{name}</span>
        <span className="ml-auto shrink-0 text-console-12 font-medium text-[color:var(--doc-tone)]">
          This step
        </span>
      </span>
    );
  return (
    <Link
      to={to}
      state={state}
      title={stepKey}
      style={toned}
      className="flex min-w-0 items-baseline gap-2 rounded-md px-2 py-1 text-console-13 text-text-secondary hover:bg-surface-hover hover:text-text-primary"
    >
      {dot}
      <span className="min-w-0 [overflow-wrap:anywhere]">{name}</span>
    </Link>
  );
}
