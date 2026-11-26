import type { ReactElement } from 'react';
import { Link } from 'react-router';
import type { FactoryStage } from '../lib/stage-steps';
import type { StageRead } from '../lib/map-live';
import { ItemsHere } from '../stage/StageItems';
import { stageModalLink } from '../lib/views';
import type { CuratedView } from '../lib/curated-view';

interface StageDetails {
  stage: FactoryStage;
  /** Why there are no items yet, until they are read. */
  live: StageRead;
}

interface MapDetailsProps {
  projectId: string;
  /** The view file's words for stages and outcomes. */
  view: CuratedView;
  /** The card's label. */
  title: string;
  /** Its stages, in the card's order. */
  stages: readonly StageDetails[];
  onClose: () => void;
}

const HEADING = 'text-console-12 font-medium uppercase tracking-console-label text-text-tertiary';

/**
 * A card's details beside the map, opened by its details button: for each of its stages, what
 * it does, what is in it, what runs it.
 */
export function MapDetails({
  projectId,
  view,
  title,
  stages,
  onClose,
}: MapDetailsProps): ReactElement {
  return (
    <aside
      aria-label={`${title} details`}
      className="relative shrink-0 rounded-console-12 border border-border bg-surface md:w-80"
    >
      {/* Beside the map the panel scrolls within the map's height rather than stretching it. */}
      <div className="flex flex-col gap-4 px-4 py-3 md:absolute md:inset-0 md:overflow-y-auto">
        <div className="flex items-baseline gap-2">
          <h4 className="text-console-15 font-semibold text-text-primary">{title}</h4>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close details"
            className="ml-auto rounded px-1 text-console-12 text-text-tertiary hover:bg-surface-hover hover:text-text-primary"
          >
            ✕
          </button>
        </div>
        {stages.map(entry => (
          <StageSection
            key={entry.stage.id}
            projectId={projectId}
            view={view}
            entry={entry}
            named={stages.length > 1}
          />
        ))}
      </div>
    </aside>
  );
}

/** One stage of the card: its label when the card has several, its blurb, items, workflows. */
function StageSection({
  projectId,
  view,
  entry,
  named,
}: {
  projectId: string;
  view: CuratedView;
  entry: StageDetails;
  named: boolean;
}): ReactElement {
  const { stage, live } = entry;
  const open = stageModalLink(projectId, stage.id);
  // A workflow's name opens the stage on that workflow's steps.
  const steps = stageModalLink(projectId, stage.id, 'workflow');
  const { workflows } = stage;
  return (
    <section aria-label={stage.label} className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        {named ? (
          <h5 className="text-console-14 font-medium text-text-primary">{stage.label}</h5>
        ) : null}
        <Link
          to={open.to}
          state={open.state}
          className="text-console-13 text-accent-bright hover:underline"
        >
          Open stage
        </Link>
      </div>
      <p className="text-console-13 leading-relaxed text-text-secondary">{stage.blurb}</p>
      <ItemsHere
        projectId={projectId}
        view={view}
        live={live}
        empty={<p className="text-console-13 text-text-tertiary">Nothing here now.</p>}
      />
      <section className="flex flex-col gap-1.5">
        <h6 className={HEADING}>Workflows</h6>
        {workflows.length === 0 ? (
          <p className="text-console-13 text-text-tertiary">No workflow runs here.</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {workflows.map(workflow => (
              <li key={workflow}>
                <Link
                  to={steps.to}
                  state={steps.state}
                  className="rounded bg-surface-elevated px-1.5 py-0.5 font-mono text-console-12 text-text-primary hover:bg-surface-hover"
                >
                  {workflow}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
