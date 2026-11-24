import { useState, type ReactElement, type ReactNode } from 'react';
import { BookOpen, GitMerge, Inbox } from 'lucide-react';
import { Link } from 'react-router';
import { EmptyNote } from '../../components/EmptyNote';
import type { FactoryItem } from '../../skills/factory';
import type { EntityView } from '../../store/cache';
import type { StageRead } from '../lib/map-live';
import { liveWorkflows, type FactoryStage } from '../lib/stage-steps';
import { factoryPath, type FactoryViewListed, type StageTab } from '../lib/views';
import { FactoryLoading } from '../FactoryLoading';
import { readFailed } from '../lib/deadline';
import { readFailure } from '../lib/read-failure';
import { ReadFailure } from '../ReadFailure';
import { useFactoryItems } from '../useFactoryItems';
import { ItemsHere } from './StageItems';
import { StageDrilldown } from './StageDrilldown';
import { StageHandOffs } from './StageHandOffs';
import { StageWorkflow } from './StageWorkflow';

type Declaration = FactoryViewListed['declaration'];

const TABS: readonly { key: StageTab; label: string }[] = [
  { key: 'does', label: 'What this stage does' },
  { key: 'items', label: 'Items here now' },
  { key: 'workflow', label: 'The real workflow' },
];

/**
 * The line under a tab saying where what it shows comes from. Contained, so in the modal it
 * never widens the panel past what the tab draws.
 */
const SOURCE = 'text-console-13 text-text-tertiary [contain:inline-size]';

/** How a caller lays out the stage's parts: its title and tabs, then the open tab's body. */
export type StageFrame = (parts: { head: ReactNode; body: ReactNode }) => ReactElement;

/**
 * The tab a stage shows. It opens on the tab the link named, else on the summary when the view
 * file gives one, else on the workflow, which is then the most this stage can say about itself.
 * Held by whoever mounts `StageView` (the modal sizes itself by the open tab), so call it in a
 * component keyed by stage: the tab picked on one stage is not on the next.
 */
export function useStageTab(
  stage: FactoryStage,
  initialTab?: StageTab
): [StageTab, (tab: StageTab) => void] {
  return useState<StageTab>(
    () => initialTab ?? (stage.drilldown === undefined ? 'workflow' : 'does')
  );
}

/**
 * One stage opened, as the Overview's modal shows it: its label and blurb, where items go from
 * it, then three tabs. "What this stage does" is the view file's summary, "Items here now" what
 * sits in it, and "The real workflow" the step graph of each workflow behind it. The
 * caller holds the tab (`useStageTab`). `frame` lays out the head and the body; the modal
 * passes one that scrolls the body alone under a fixed head.
 */
export function StageView({
  projectId,
  view,
  stage,
  live,
  titleId,
  tab,
  onTab,
  frame,
}: {
  projectId: string;
  view: Declaration;
  stage: FactoryStage;
  /** The stage's items, as the map's chips read them. */
  live: StageRead;
  /** The id its title carries, for the dialog that names itself by it. */
  titleId?: string;
  tab: StageTab;
  onTab: (tab: StageTab) => void;
  frame: StageFrame;
}): ReactElement {
  const items = useFactoryItems(projectId);
  return frame({
    head: (
      <>
        <div className="flex flex-col gap-2">
          <h3 id={titleId} className="text-console-17 font-semibold text-text-primary">
            {stage.label}
          </h3>
          <p className="max-w-3xl text-console-14 leading-relaxed text-text-secondary">
            {stage.blurb}
          </p>
          <StageHandOffs view={view} stage={stage.id} />
        </div>
        <StageTabs active={tab} onSelect={onTab} />
        <ItemsReadNotice items={items} />
      </>
    ),
    body: (
      <TabBody
        projectId={projectId}
        view={view}
        stage={stage}
        live={live}
        tab={tab}
        items={items}
      />
    ),
  });
}

/** The open tab: the summary, the items, or the step graph of each workflow the pack runs now. */
function TabBody({
  projectId,
  view,
  stage,
  live,
  tab,
  items,
}: {
  projectId: string;
  view: Declaration;
  stage: FactoryStage;
  live: StageRead;
  tab: StageTab;
  items: EntityView<FactoryItem[]>;
}): ReactElement {
  if (tab === 'items')
    return <StageItemsTab projectId={projectId} view={view} stage={stage} live={live} />;
  const workflows = liveWorkflows(view, stage);
  if (tab === 'workflow')
    return (
      <>
        <p className={SOURCE}>Generated from the pack's workflow files; shows every step.</p>
        {workflows.length === 0 ? (
          <EmptyNote
            icon={GitMerge}
            sentence="No workflow runs in this stage. An item arrives here when its change merges."
            className="flex flex-col items-start gap-2 [contain:inline-size]"
          />
        ) : (
          workflows.map(workflow => (
            <StageWorkflow
              key={workflow}
              projectId={projectId}
              view={view}
              stage={stage}
              workflow={workflow}
              items={items}
            />
          ))
        )}
      </>
    );
  return (
    <>
      <p className={SOURCE}>The factory's summary of this stage, from its view file.</p>
      {stage.drilldown === undefined ? (
        <EmptyNote
          icon={BookOpen}
          sentence={
            // Point at the real workflow only when there is one to read.
            workflows.length === 0
              ? 'This stage has no summary and no workflow runs in it. An item arrives here when its change merges.'
              : 'This stage has no summary. The real workflow shows its steps.'
          }
        />
      ) : (
        <StageDrilldown
          projectId={projectId}
          view={view}
          stage={stage}
          drilldown={stage.drilldown}
          items={items}
        />
      )}
    </>
  );
}

/** The three tabs; the active one takes the accent (owner change of 2026-11-19, point 1). */
function StageTabs({
  active,
  onSelect,
}: {
  active: StageTab;
  onSelect: (tab: StageTab) => void;
}): ReactElement {
  return (
    <div
      role="tablist"
      aria-label="What this stage shows"
      className="flex flex-wrap gap-1 border-b border-border"
    >
      {TABS.map(({ key, label }) => {
        const on = key === active;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onSelect(key)}
            className={`relative -mb-px px-3 py-2 text-console-14 transition-colors duration-150 ease-out ${
              on ? 'font-medium text-text-primary' : 'text-text-tertiary hover:text-text-primary'
            }`}
          >
            {label}
            {on ? (
              <span
                aria-hidden="true"
                className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-accent-bright"
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The one word every tab gets about the items read, above whichever tab is open: a read that
 * failed says why with a Retry; one that failed after a good read says what follows is from
 * that last read, so no tab passes old items off as here now; a slow one says it is trying
 * again. The tabs draw no notice of their own.
 */
function ItemsReadNotice({ items }: { items: EntityView<FactoryItem[]> }): ReactElement | null {
  const failed = readFailed(items.error);
  if (failed !== undefined)
    return (
      <ReadFailure retry={items.refetch}>
        {items.data === undefined
          ? `Could not read the items in this stage: ${readFailure(failed)}`
          : `Could not refresh the items, so this stage shows the last ones read: ${readFailure(failed)}`}
      </ReadFailure>
    );
  return items.error === undefined ? null : <FactoryLoading read={items} />;
}

/** "Items here now": the stage's items, or rule 6's empty state. */
function StageItemsTab({
  projectId,
  view,
  stage,
  live,
}: {
  projectId: string;
  view: Declaration;
  stage: FactoryStage;
  live: StageRead;
}): ReactElement {
  return (
    <ItemsHere
      projectId={projectId}
      view={view}
      stage={stage}
      live={live}
      resting
      empty={
        <EmptyNote
          icon={Inbox}
          sentence="Nothing is in this stage now."
          link={
            <Link
              to={factoryPath(projectId, '/board')}
              className="text-accent-bright hover:underline"
            >
              See every item on the board
            </Link>
          }
        />
      }
    />
  );
}
