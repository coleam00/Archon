import type { ReactElement, ReactNode } from 'react';
import { BookOpen, MessageCircleQuestion } from 'lucide-react';
import { useAnsweredHold } from '../components/ask-card/useAnsweredHold';
import { EmptyNote } from '../components/EmptyNote';
import { SkeletonBlock, SkeletonGroup } from '../components/Skeleton';
import { askNaming } from '../lib/ask-naming';
import { errorDetail } from '../lib/http';
import { askRunId, type NeedsYouItem } from '../lib/needs-you';
import { useProjectAttention } from '../components/ProjectAttention';
import { Panel, SectionHeading } from './document';
import { FactoryLoading } from './FactoryLoading';
import { ItemAwaitsPanel, type Awaits } from './ItemAwaits';
import { readFailed } from './lib/deadline';
import type { StoryPanel } from './lib/item-story';
import type { FactoryViewListed } from './lib/views';
import { OpenAsks } from './StoryAsks';
import { DrainStoryPanel, MergedStoryPanel, StageStoryPanel } from './StoryPanel';

/**
 * The item's story (owner change 8): one panel per stage visit in the order it ran. An open ask
 * shows as the ask card, answerable in place, in the panel of the run that asked; one no panel
 * holds waits on its own panel at the top. Answered cards are held in place for a moment
 * (`useAnsweredHold`), held here so the last answer does not unmount its own card. An item
 * waiting on you with no ask open says what it waits on first.
 */
export function ItemStory({
  projectId,
  view,
  panels,
  asks,
  questions,
  awaits,
}: {
  projectId: string;
  view: FactoryViewListed;
  panels: readonly StoryPanel[];
  asks: NeedsYouItem[];
  /** How many questions the item read says are open, so a queue still loading shows a skeleton. */
  questions: number;
  /** What the item waits on when its pill is `awaits`; null otherwise. */
  awaits: Awaits | null;
}): ReactElement {
  const hold = useAnsweredHold(asks);
  const queue = useProjectAttention().data;
  const naming = askNaming(projectId, view);
  const inPanel = new Set(panels.flatMap(panel => (panel.kind === 'stage' ? panel.runIds : [])));
  const loose = hold.asks.filter(ask => !inPanel.has(askRunId(ask) ?? ''));
  const asksOf = (runIds: readonly string[]): ReactNode =>
    queue === undefined ? null : (
      <OpenAsks
        projectId={projectId}
        asks={hold.asks.filter(ask => runIds.includes(askRunId(ask) ?? ''))}
        hold={hold}
        queue={queue}
        naming={naming}
      />
    );
  return (
    <div className="flex min-w-0 flex-col gap-4" aria-label="The story">
      {awaits === null ? null : <ItemAwaitsPanel awaits={awaits} />}
      <Waiting
        loose={
          queue === undefined || loose.length === 0 ? null : (
            <OpenAsks
              projectId={projectId}
              asks={loose}
              hold={hold}
              queue={queue}
              naming={naming}
            />
          )
        }
        questions={questions}
      />
      {panels.length === 0 ? (
        <Panel className="p-5">
          <EmptyNote icon={BookOpen} sentence="No run has worked this item yet." />
        </Panel>
      ) : (
        panels.map(panel => {
          if (panel.kind === 'stage')
            return (
              <StageStoryPanel
                key={panel.key}
                view={view.declaration}
                panel={panel}
                asks={asksOf(panel.runIds)}
              />
            );
          if (panel.kind === 'drain') return <DrainStoryPanel key={panel.key} panel={panel} />;
          return <MergedStoryPanel key={panel.key} view={view.declaration} panel={panel} />;
        })
      )}
    </div>
  );
}

/**
 * The asks no stage panel holds, and the state of the queue the asks are read from: a skeleton
 * while it loads for an item with open questions, a line when it could not be read.
 */
function Waiting({ loose, questions }: { loose: ReactNode; questions: number }): ReactNode {
  const attention = useProjectAttention();
  const failed = readFailed(attention.error);
  if (loose === null && (questions === 0 || attention.data !== undefined)) return null;
  return (
    <Panel
      as="section"
      tone="var(--warning)"
      bar="left"
      aria-labelledby="story-waiting"
      className="flex flex-col gap-3 py-4 pl-6 pr-5"
    >
      <SectionHeading
        id="story-waiting"
        icon={MessageCircleQuestion}
        eyebrow="Needs you"
        title="Waiting on you"
        tone="var(--warning)"
      />
      {loose ??
        (failed === undefined ? (
          <FactoryLoading read={attention}>
            <SkeletonGroup label="Loading what waits on you">
              <SkeletonBlock height="h-32" rounded="rounded-console-16" />
            </SkeletonGroup>
          </FactoryLoading>
        ) : (
          <p className="text-console-13 text-text-tertiary">
            What waits on you could not be loaded: {errorDetail(failed)}
          </p>
        ))}
    </Panel>
  );
}
