import { useMemo, type ReactElement, type ReactNode } from 'react';
import {
  Activity,
  CircleCheck,
  GitMerge,
  type LucideIcon,
  MessageCircleQuestionMark,
  Search,
  Timer,
} from 'lucide-react';
import { Link } from 'react-router';
import { errorDetail } from '../lib/http';
import { useFactoryItems } from './useFactoryItems';
import { boardModel, type FactoryDeclaration } from './lib/board';
import { boardShowSearch } from './lib/board-show';
import { durationWords } from './lib/duration';
import { factoryNumbers, type FactoryNumbers as Numbers } from './lib/numbers';
import { factoryPath } from './lib/views';
import { FactoryLoading } from './FactoryLoading';
import { readFailed } from './lib/deadline';
import { SkeletonFigure } from '../components/Skeleton';
import { StaleRead } from './StaleRead';
import { openFindings } from './lib/discoveries';
import { useFactoryDiscoveries } from './useFactoryDiscoveries';
import { useMinuteClock } from './useMinuteClock';

/**
 * A tile whose items are not read shows a skeleton bar (rule 6), never a wrong count and
 * never "…". One whose count leaves out items with a merge state still being read shows the
 * known count with a skeleton bar beside it (`pending`). Items whose merge state could not be
 * read are left out too, but said in words under the strip (`UnknownMerges`), since a
 * skeleton means loading and they may never settle.
 */
type TileValue = { value: null } | { value: string; pending: boolean };

type Tile = TileValue & {
  label: string;
  icon: LucideIcon;
  /** What the number means, as the tile's tooltip. */
  means?: string;
};

/**
 * The five tiles, each a skeleton while `numbers` is not read (undefined). `waiting` is the
 * project's asks and waits (`needsYouCount`, undefined until the queue loads): the count the
 * Needs you tab and its heading show.
 */
function tiles(numbers: Numbers | undefined, waiting: number | undefined): Tile[] {
  // Every number but "needs you" depends on which items merged (placement rule 2).
  const merged = (value: (n: Numbers) => string): TileValue =>
    numbers === undefined ? { value: null } : { value: value(numbers), pending: numbers.pending };
  return [
    {
      ...merged(n => n.inFlight.toString()),
      label: 'in flight',
      icon: Activity,
    },
    {
      ...(waiting === undefined ? { value: null } : { value: waiting.toString(), pending: false }),
      label: waiting === 1 ? 'needs you' : 'need you',
      icon: MessageCircleQuestionMark,
    },
    {
      ...merged(n => n.landedToday.toString()),
      label: 'merged today',
      icon: GitMerge,
    },
    {
      ...merged(n => `${n.landed.toString()} of ${n.total.toString()}`),
      label: 'merged',
      icon: CircleCheck,
    },
    {
      ...merged(n => (n.medianToLandMs === null ? 'none yet' : durationWords(n.medianToLandMs))),
      label: 'median to merged',
      means: "The median time from an item's first run to its change merging",
      icon: Timer,
    },
  ];
}

/**
 * The Overview's numbers strip. It reads the board's items under the board's cache key and
 * counts with the board's own filter, so each number matches the board. The tiles are plain
 * figures, not links (owner change of 2026-11-23); only the line naming unreadable merge
 * states links, to the board narrowed to them.
 */
export function FactoryNumbers({
  projectId,
  view,
  waiting,
}: {
  projectId: string;
  view: FactoryDeclaration;
  /** The project's asks and waits (`needsYouCount`); undefined until the queue loads. */
  waiting: number | undefined;
}): ReactElement {
  const items = useFactoryItems(projectId);
  const now = useMinuteClock();
  const numbers = useMemo(
    () =>
      items.data === undefined
        ? undefined
        : factoryNumbers(boardModel(view, projectId, items.data, new Map(), now), now),
    [view, projectId, items.data, now]
  );
  const failed = readFailed(items.error);
  if (numbers === undefined && failed !== undefined)
    return (
      <p role="alert" className="text-console-14 text-error">
        The numbers could not be loaded: {errorDetail(failed)}
      </p>
    );
  return (
    <div className="flex flex-col gap-2">
      {numbers === undefined ? null : <StaleRead error={items.error} />}
      {/* Before the first answer the tiles show skeletons; a read past its deadline says so. */}
      {numbers === undefined ? <FactoryLoading read={items} /> : null}
      <ul
        aria-label="Numbers"
        className={`grid grid-cols-2 gap-3 ${
          view.discoveries === undefined ? 'sm:grid-cols-5' : 'sm:grid-cols-3 lg:grid-cols-6'
        }`}
      >
        {tiles(numbers, waiting).map(tile => (
          <NumberTile key={tile.label} label={tile.label} icon={tile.icon} means={tile.means}>
            {tile.value === null ? (
              <FigureSkeleton title="Loading" />
            ) : (
              <span className="whitespace-nowrap">{tile.value}</span>
            )}
            {tile.value !== null && tile.pending ? <BesideSkeleton /> : null}
          </NumberTile>
        ))}
        {view.discoveries === undefined ? null : <FoundTile projectId={projectId} />}
      </ul>
      {numbers === undefined || numbers.unknown === 0 ? null : (
        <UnknownMerges projectId={projectId} count={numbers.unknown} />
      )}
    </div>
  );
}

/**
 * One number tile, in the card language (Visual standard, rules 1 and 2): an icon and the
 * label in the Label role, then the figure at the tile figure's size. A plain figure: no link,
 * no hover or focus state. Its tooltip says what the number means, where that needs saying.
 */
function NumberTile({
  label,
  icon: Icon,
  means,
  children,
}: {
  label: string;
  icon: LucideIcon;
  means?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <li data-tile={label}>
      <div
        title={means}
        className="flex h-full flex-col gap-2 rounded-console-12 border border-border bg-surface p-3"
      >
        <span className="flex items-start gap-1.5 text-console-12 font-medium uppercase tracking-console-label text-text-tertiary">
          <Icon aria-hidden="true" className="size-4 shrink-0" />
          {label}
        </span>
        <span className="flex h-7 items-center gap-2 text-console-22 font-semibold tabular-nums text-text-primary">
          {children}
        </span>
      </div>
    </li>
  );
}

/** A figure not known yet, with why for a screen reader and on hover. */
function FigureSkeleton({ title }: { title: string }): ReactElement {
  return (
    <span title={title} className="inline-flex items-center">
      <SkeletonFigure />
      <span className="sr-only">{title}</span>
    </span>
  );
}

/**
 * How many items the numbers leave out because their merge state could not be read, linking
 * to the board narrowed to them. Said in words (Visual standard rule 6: an error says what
 * could not be read), not as a skeleton, which would read as loading that never ends.
 */
function UnknownMerges({ projectId, count }: { projectId: string; count: number }): ReactElement {
  const opens = 'Open the board, only the items whose merge state could not be read';
  return (
    <p className="text-console-13 text-text-secondary">
      <Link
        to={factoryPath(projectId, `/board${boardShowSearch('unknown')}`)}
        title={opens}
        className="text-accent transition-colors duration-150 ease-out hover:text-text-primary"
      >
        {count} merge {count === 1 ? 'state' : 'states'} could not be read
      </Link>
      <span className="sr-only">, {opens}</span>
    </p>
  );
}

/**
 * The bar beside a known count that leaves out items with a merge state still being read. The
 * figure never wraps: in a narrow tile the bar gives way, clipped to the room left.
 */
function BesideSkeleton(): ReactElement {
  return (
    <span className="flex min-w-0 shrink overflow-hidden">
      <FigureSkeleton title="Checking which changes merged" />
    </span>
  );
}

/**
 * "found by the factory": what the discoveries drains decided to file that no item carries
 * yet. Its own read, so it never holds up the other tiles; a
 * read that failed reads as a dash, and the panel says why.
 */
function FoundTile({ projectId }: { projectId: string }): ReactElement {
  const read = useFactoryDiscoveries(projectId);
  const failed = read.data === undefined && readFailed(read.error) !== undefined;
  return (
    <NumberTile label="found by the factory" icon={Search}>
      {read.data !== undefined ? (
        openFindings(read.data).length
      ) : failed ? (
        <span title="Could not be read">–</span>
      ) : (
        <FigureSkeleton title="Loading" />
      )}
    </NumberTile>
  );
}
