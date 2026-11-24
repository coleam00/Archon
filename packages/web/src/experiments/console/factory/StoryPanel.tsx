import { useState, type ReactElement, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Telescope, Wrench } from 'lucide-react';
import { formatCost, formatDateTime } from '../lib/format';
import { DefinitionGrid, Panel, SectionHeading } from './document';
import { boardColumns, type ColumnTone } from './lib/board-columns';
import { FOUND_BY_THE_FACTORY_LABEL } from './lib/discoveries';
import { durationWords } from './lib/duration';
import type {
  DrainPanel,
  MergedPanel,
  PanelDetails,
  PanelEvent,
  Reason,
  Sentence,
  StagePanel,
} from './lib/item-story';
import type { TimelineShadow } from './lib/timeline';
import type { FactoryViewListed } from './lib/views';
import { MEANING_WORD } from './lib/item-rounds-grid';
import { Reason as ReasonLine, RoundsGrid } from './RoundsGrid';
import { ShadowRow } from './ShadowRow';
import { AnsweredAskBlock } from './StoryAsks';
import { TONES, toneColor } from './tones';

type Declaration = FactoryViewListed['declaration'];

/** The board column holding a stage: its label for the eyebrow, its tone for the colour. */
function columnOf(view: Declaration, stage: string): { label: string; tone: ColumnTone } {
  const column = boardColumns(view).find(entry => entry.stages.includes(stage));
  return column ?? { label: stage, tone: 'intake' };
}

/**
 * One stage of the story (owner change 8): a panel in its column's colour, the stage as its
 * heading (a later visit numbered), one plain sentence of what happened, the check rounds as a
 * grid on a Checks panel, the asks it left where they happened, its details, and the shadow
 * steps' decisions, quieter than the real steps (rule 10).
 */
export function StageStoryPanel({
  view,
  panel,
  asks,
}: {
  view: Declaration;
  panel: StagePanel;
  /** The open ask cards of this panel's runs. */
  asks: ReactNode;
}): ReactElement {
  const column = columnOf(view, panel.stage.id);
  const tone = toneColor(column.tone);
  const id = `story-${panel.key}`;
  return (
    <Panel
      as="section"
      tone={tone}
      bar="left"
      aria-labelledby={id}
      data-story-panel={panel.stage.id}
      className="flex flex-col gap-4 py-4 pl-6 pr-5"
    >
      <SectionHeading
        id={id}
        icon={TONES[column.tone].Icon}
        eyebrow={column.label}
        title={panel.number > 1 ? `${panel.stage.label} (${panel.number})` : panel.stage.label}
        tone={tone}
      />
      <StorySentence panel={panel} />
      {panel.grid === null ? null : <RoundsGrid grid={panel.grid} />}
      <Happened events={panel.happened} />
      {panel.answered.map(ask => (
        <AnsweredAskBlock key={`${ask.runId}|${ask.at}|${ask.question}`} ask={ask} />
      ))}
      {asks}
      <DefinitionGrid rows={detailRows(panel.details, panel.merged)} />
      <Shadows shadows={panel.shadows} />
    </Panel>
  );
}

/**
 * A panel's send-backs and folded fixes before its last run, without a grid (CI and the reviews
 * sent it back, the builder fixed it): each in one sentence, a reason's rest behind "More".
 */
function Happened({ events }: { events: readonly PanelEvent[] }): ReactNode {
  if (events.length === 0) return null;
  return (
    <ul aria-label="What happened here before" className="flex flex-col gap-2">
      {events.map(event =>
        event.kind === 'sent-back' ? (
          <ReasonLine key={event.runId} lead={MEANING_WORD.returned} text={event.reason.full} />
        ) : (
          <li
            key={event.runId}
            data-fixed=""
            className="flex items-center gap-1.5 text-console-13 text-text-secondary"
          >
            <Wrench aria-hidden="true" className="size-4 shrink-0 text-text-tertiary" />
            {event.text}
          </li>
        )
      )}
    </ul>
  );
}

/** The panel's one sentence, with the console's clauses: the PR, why it was sent back, your answer. */
function StorySentence({ panel }: { panel: StagePanel }): ReactElement {
  const [open, setOpen] = useState(false);
  const { reason } = panel;
  return (
    <div className="flex max-w-[80ch] flex-col gap-1.5">
      <p data-story-sentence="" className="break-words text-console-15 text-text-primary">
        <SentenceText sentence={panel.sentence} />
        {panel.pr === null ? null : (
          <>
            {' '}
            and opened{' '}
            <a
              href={panel.pr.url}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-accent-bright hover:underline"
            >
              {panel.pr.label}
            </a>
          </>
        )}
        {reason === null ? null : `: ${reason.short.replace(/[.!?…]$/, '')}`}
        {panel.youSaid === null ? null : `; you said ${panel.youSaid}`}.
        <MoreButton reason={reason} open={open} onToggle={() => setOpen(!open)} />
      </p>
      {open && reason !== null ? (
        <p className="whitespace-pre-line break-words text-console-13 text-text-secondary">
          {reason.full}
        </p>
      ) : null}
    </div>
  );
}

function MoreButton({
  reason,
  open,
  onToggle,
}: {
  reason: Reason | null;
  open: boolean;
  onToggle: () => void;
}): ReactNode {
  if (reason === null || reason.short === reason.full) return null;
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="ml-2 rounded text-console-12 font-medium text-text-tertiary hover:text-text-primary"
    >
      {open ? 'Less' : 'More'}
    </button>
  );
}

function SentenceText({ sentence }: { sentence: Sentence }): ReactElement {
  return (
    <>
      {sentence.text}
      {sentence.mono === null ? null : <span className="ml-1 font-mono">{sentence.mono}</span>}
    </>
  );
}

/** When, how long, what it cost, which models, and the runs, as a definition grid. */
function detailRows(details: PanelDetails, merged: string | null) {
  const rows: { key: string; label: string; value: ReactNode }[] = [];
  if (merged !== null) rows.push({ key: 'merged', label: 'Merged', value: formatDateTime(merged) });
  if (details.start !== '')
    rows.push({
      key: 'when',
      label: 'When',
      value: `${formatDateTime(details.start)} to ${details.end === null ? 'now' : formatDateTime(details.end)}`,
    });
  if (details.durationMs !== null)
    rows.push({ key: 'took', label: 'Took', value: durationWords(details.durationMs) });
  rows.push({
    key: 'cost',
    label: 'Cost',
    value: costWords(details),
  });
  if (details.models.length > 0)
    rows.push({
      key: 'models',
      label:
        details.models.length === 1
          ? 'Model'
          : details.wholeRun
            ? 'Models (all its runs)'
            : 'Models',
      value: <span className="font-mono text-console-13">{details.models.join(', ')}</span>,
    });
  rows.push({
    key: 'runs',
    label: details.runs.length === 1 ? 'Run' : 'Runs',
    value: <RunLinks runs={details.runs} />,
  });
  return rows;
}

/** The cost, said to be the whole run's when the run worked other stages too. */
/**
 * The cost, said to be its runs' whole cost when a run worked other stages too: a run records
 * one cost, which cannot be split by stage. Several runs say how many, so two panels' totals
 * never both claim to be "the whole run".
 */
function costWords(details: PanelDetails): string {
  if (details.costUsd === null) return 'Not recorded';
  const cost = formatCost(details.costUsd);
  if (!details.wholeRun) return cost;
  const count = details.runs.length;
  return count === 1
    ? `${cost} for the whole run, across its stages`
    : `${cost} for its ${count.toString()} runs, across their stages`;
}

function RunLinks({ runs }: { runs: PanelDetails['runs'] }): ReactElement {
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1">
      {runs.map(run => (
        <Link
          key={run.id}
          to={run.href}
          className="font-mono text-console-13 text-accent-bright hover:underline"
        >
          {run.id.slice(0, 8)}
        </Link>
      ))}
    </span>
  );
}

/** The shadow steps' decisions, quieter than the real steps (rule 10). */
function Shadows({ shadows }: { shadows: readonly TimelineShadow[] }): ReactNode {
  if (shadows.length === 0) return null;
  return (
    <ol aria-label="What its shadow steps would have done" className="flex flex-col gap-1.5">
      {shadows.map(shadow => (
        <ShadowRow key={shadow.key} shadow={shadow} />
      ))}
    </ol>
  );
}

/** A drain's run, on no stage: told quietly, in the shadow's colour while it only decides. */
export function DrainStoryPanel({ panel }: { panel: DrainPanel }): ReactElement {
  return (
    <Panel
      as="section"
      tone="var(--node-opaque)"
      bar="left"
      aria-label={FOUND_BY_THE_FACTORY_LABEL}
      data-story-panel="drain"
      className="flex flex-col gap-3 py-4 pl-6 pr-5"
    >
      <SectionHeading
        icon={Telescope}
        eyebrow="Beside the work"
        title={FOUND_BY_THE_FACTORY_LABEL}
        tone="var(--node-opaque)"
      />
      <p data-story-sentence="" className="text-console-14 text-text-secondary">
        <SentenceText sentence={panel.sentence} />.
      </p>
      <DefinitionGrid rows={detailRows(panel.details, null)} />
      <Shadows shadows={panel.shadows} />
    </Panel>
  );
}

/** The change merged, with no run of the Merged stage to tell it: when, as the host said. */
export function MergedStoryPanel({
  view,
  panel,
}: {
  view: Declaration;
  panel: MergedPanel;
}): ReactElement {
  const column = columnOf(view, view.landed.stage);
  const tone = toneColor(column.tone);
  return (
    <Panel
      as="section"
      tone={tone}
      bar="left"
      aria-label="Merged"
      data-story-panel="merged"
      className="flex flex-col gap-3 py-4 pl-6 pr-5"
    >
      <SectionHeading
        icon={TONES[column.tone].Icon}
        eyebrow={column.label}
        title={panel.stage?.label ?? column.label}
        tone={tone}
      />
      <p data-story-sentence="" className="text-console-15 text-text-primary">
        The change merged{panel.at === null ? '' : ` ${formatDateTime(panel.at)}`}.
      </p>
    </Panel>
  );
}
