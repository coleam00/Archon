import { useMemo, useState, type ReactElement } from 'react';
import { displayItemKey } from './lib/item-key';
import { displayKeyOf } from './lib/work-orders';
import { FileQuestionMark } from 'lucide-react';
import { Link } from 'react-router';
import { EmptyNote } from '../components/EmptyNote';
import { itemPath } from './lib/board';
import { closestItems } from './lib/item-search';
import { WAY_ON_LINK } from './FactoryNotFound';
import { factoryPath } from './lib/views';
import { useFactoryItemsRead } from './useFactoryItems';

/**
 * The page of a key the project has no item and no work order under (Visual standard, rule 6):
 * it says so, and offers the ways on, the board and a search over the items.
 */
export function ItemNotFound({
  projectId,
  itemKey,
}: {
  projectId: string;
  itemKey: string;
}): ReactElement {
  return (
    <EmptyNote
      icon={FileQuestionMark}
      sentence={
        <>
          There is no item <span className="font-mono">{displayItemKey(itemKey, null)}</span> in
          this project.
        </>
      }
      className="flex w-full max-w-xl flex-col items-start gap-2"
      link={
        <div className="flex w-full flex-col gap-3">
          <Link to={factoryPath(projectId, '/board')} className={`self-start ${WAY_ON_LINK}`}>
            Open the board
          </Link>
          <ItemSearch projectId={projectId} />
        </div>
      }
    />
  );
}

/**
 * Find an item by key or title, over the items read every Factory page shares (no request of
 * its own). It lists nothing until the person types: the missing key itself usually matches
 * nothing, so it is not filled in.
 */
function ItemSearch({ projectId }: { projectId: string }): ReactElement {
  const [query, setQuery] = useState('');
  return (
    <div className="flex w-full flex-col gap-2">
      <input
        type="search"
        aria-label="Find an item by key or title"
        placeholder="Key or title"
        value={query}
        onChange={event => {
          setQuery(event.target.value);
        }}
        className="w-full max-w-sm rounded-md border border-border bg-surface px-2.5 py-1.5 text-console-13 text-text-primary placeholder:text-text-tertiary"
      />
      <ItemSuggestions projectId={projectId} query={query} />
    </div>
  );
}

function ItemSuggestions({
  projectId,
  query,
}: {
  projectId: string;
  query: string;
}): ReactElement | null {
  // Drawn only once the items read has landed (`NoSuchItem` waits for it to rule out a work
  // order), and the cache keeps that value through a failed refresh.
  const { data } = useFactoryItemsRead(projectId);
  const found = useMemo(
    () => (data === undefined ? [] : closestItems(data.items, query)),
    [data, query]
  );
  if (query.trim() === '') return null;
  // The items read lists only items with a run (`factory-items-read.ts`), so no match here is
  // not proof that a key never existed: the words say what was searched.
  if (found.length === 0)
    return <p className="text-console-13 text-text-tertiary">No item with a run matches.</p>;
  return (
    <ul aria-label="Matching items" className="flex flex-col gap-1">
      {found.map(item => (
        <li key={item.item.key} className="min-w-0">
          <Link
            to={itemPath(projectId, item.item.key)}
            className="flex min-w-0 items-baseline gap-2 text-text-primary transition-colors duration-150 ease-out hover:text-accent-bright"
          >
            <span className="shrink-0 font-mono text-text-secondary">{displayKeyOf(item)}</span>
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {item.progress?.title ?? displayKeyOf(item)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
