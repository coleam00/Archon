import { useMemo, type ReactElement } from 'react';
import { Link } from 'react-router';
import { Activity, Inbox } from 'lucide-react';
import { EmptyNote } from '../../components/EmptyNote';
import { SkeletonGroup, SkeletonLine } from '../../components/Skeleton';
import { BoardCard } from '../BoardCard';
import { FactoryLoading } from '../FactoryLoading';
import { WAY_ON_LINK } from '../FactoryNotFound';
import { Panel, SectionHeading } from '../document';
import { RunningItemsFailure } from '../RunningItems';
import { toneColor } from '../tones';
import type { BoardAsks } from '../useBoardAsks';
import { useFactoryItems } from '../useFactoryItems';
import { cardFields } from '../lib/board';
import { boardColumns } from '../lib/board-columns';
import { readFailed } from '../lib/deadline';
import { itemsOnStep, type ItemOnStep } from '../lib/items-on-step';
import { pageItemColumn } from '../lib/placement';
import { factoryPath, type FactoryViewListed } from '../lib/views';

type Declaration = FactoryViewListed['declaration'];

/** The items a run has on `stepKey` now (`itemsOnStep`), the read, and what to retry. */
export function useItemsOnStep(
  projectId: string,
  workflow: string,
  stepKey: string
): { onStep: ItemOnStep[] | undefined; read: ReturnType<typeof useFactoryItems> } {
  const read = useFactoryItems(projectId);
  const onStep = useMemo(
    () =>
      read.data === undefined ? undefined : (itemsOnStep(read.data, workflow).get(stepKey) ?? []),
    [read.data, workflow, stepKey]
  );
  return { onStep, read };
}

/**
 * The cards carry no ask's face here: an item on a step is one a run works now, and an ask is
 * answered from the board or Needs you, which hold the project's queue. With no face a card
 * shows its stop line, as the board does before its queue is read.
 */
const NO_ASKS: BoardAsks = {
  asksOf: () => null,
  faceOf: () => null,
  answeredLine: () => null,
  open: null,
  openFor: () => undefined,
  close: () => undefined,
  settle: () => undefined,
};

const ITEMS_TONE = 'var(--running)';

/** "Items on this step now": the board's cards, or the designed empty state. */
export function StepItems({
  projectId,
  view,
  onStep,
  read,
}: {
  projectId: string;
  view: Declaration;
  onStep: ItemOnStep[] | undefined;
  read: ReturnType<typeof useFactoryItems>;
}): ReactElement {
  return (
    <section data-doc-section="" className="flex flex-col gap-3">
      <SectionHeading
        icon={Activity}
        eyebrow="On this step now"
        title="Items on this step now"
        tone={ITEMS_TONE}
        count={onStep?.length}
      />
      <StepItemsBody projectId={projectId} view={view} onStep={onStep} read={read} />
    </section>
  );
}

function StepItemsBody({
  projectId,
  view,
  onStep,
  read,
}: {
  projectId: string;
  view: Declaration;
  onStep: ItemOnStep[] | undefined;
  read: ReturnType<typeof useFactoryItems>;
}): ReactElement {
  // A failed refresh keeps the last list in the cache; it is no longer evidence of what runs.
  const failed = readFailed(read.error);
  if (failed !== undefined)
    return (
      <Panel className="p-4">
        <RunningItemsFailure error={failed} retry={read.refetch} />
      </Panel>
    );
  // A slow refresh, like a failed one, leaves the last list no evidence: retry and say so.
  if (read.error !== undefined || onStep === undefined)
    return (
      <Panel className="p-4">
        <FactoryLoading read={read}>
          <SkeletonGroup label="Reading which items are on this step">
            <SkeletonLine width="short" />
          </SkeletonGroup>
        </FactoryLoading>
      </Panel>
    );
  if (onStep.length === 0)
    return (
      <Panel className="p-5">
        <EmptyNote
          icon={Inbox}
          sentence="No item is on this step now."
          link={
            <Link to={factoryPath(projectId, '/board')} className={WAY_ON_LINK}>
              Open the board
            </Link>
          }
        />
      </Panel>
    );
  const columns = boardColumns(view);
  return (
    <Panel className="p-4">
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {onStep.map(({ item }) => {
          const column = pageItemColumn(view, item);
          const stage = column !== null && 'stage' in column ? column.stage.id : undefined;
          const tone = columns.find(candidate =>
            stage === undefined ? false : candidate.stages.includes(stage)
          )?.tone;
          return (
            <li key={item.item.id}>
              <BoardCard
                projectId={projectId}
                card={cardFields(view, projectId, item, column)}
                moved={false}
                accent={tone === undefined ? 'var(--node-opaque)' : toneColor(tone)}
                asks={NO_ASKS}
              />
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
