/**
 * What board cards read beyond the item read, shared by every card list of a board: each of the
 * project's packs' graph and factory view, and the project's open asks by item. A card list
 * reads the run records and forge answers its own cards need in batches (`useCardList`). With no
 * provider (a test drawing a pack board alone) cards show what the item read alone gives.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { getPackGraph, type ItemRead } from '../skills/items';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import {
  forgePending,
  getForgeSubjects,
  getPackViewRead,
  getRunRecords,
  type ForgeSubjects,
  type RunRecord,
  type RunRecords,
} from './api';
import { CardsContext, useFactoryCards, type FactoryCards } from './cards-context';
import { issueNumber } from '../lib/item-key';
import { itemAsksOf, type AskRead } from './lib/item-asks';
import {
  cardProgress,
  OUTPUT_KEYS,
  packOf,
  resultKeys,
  runsToRead,
  type CardPack,
  type CardProgress,
} from './lib/item-card';

/**
 * What one pack's reads gave: its graph's stages and its view, or that its graph could not be
 * read. A view that could not be read still gives the stages, so the board places by them, and
 * marks the cards unread.
 */
type PackReadResult = (CardPack & { viewFailed: boolean }) | 'error';

/**
 * One pack's graph and factory view, reported to the provider. The graph is read through the
 * board's own `K.packGraph` entry, so the stage columns and the cards share one read. The view
 * is asked for at the same time: the server answers both from one graph read
 * (`shareWhileRunning`, over its kept discovery), so neither waits on the other.
 */
function PackRead({
  projectId,
  pack,
  onRead,
}: {
  projectId: string;
  pack: string;
  onRead: (pack: string, result: PackReadResult) => void;
}): null {
  const graph = useEntity(K.packGraph(projectId, pack), () => getPackGraph(projectId, pack));
  const view = useEntity(K.packView(projectId, pack), () => getPackViewRead(projectId, pack));
  const stages = graph.data?.stages;
  const failed = graph.error !== undefined;
  const viewFailed = view.error !== undefined;
  const viewRead = view.data !== undefined;
  // The map reads the whole view read under this key; a card reads only its view.
  const viewData = view.data?.view ?? null;
  useEffect(() => {
    if (failed) onRead(pack, 'error');
    else if (stages !== undefined && (viewRead || viewFailed))
      onRead(pack, { stages, view: viewFailed ? null : viewData, viewFailed });
  }, [failed, onRead, pack, stages, viewData, viewRead, viewFailed]);
  return null;
}

export function FactoryCardsProvider({
  projectId,
  packs,
  itemAsks,
  children,
}: {
  projectId: string;
  /** The project's packs; null while the project is still being read. */
  packs: readonly string[] | null;
  /** The project's asks, which the cards and their column headers count. */
  itemAsks: AskRead;
  children: ReactNode;
}): ReactElement {
  const [read, setRead] = useState<ReadonlyMap<string, PackReadResult>>(new Map());
  const onRead = useCallback((pack: string, result: PackReadResult): void => {
    setRead(prev => (prev.get(pack) === result ? prev : new Map(prev).set(pack, result)));
  }, []);
  const readPacks = new Map<string, CardPack>();
  for (const [pack, result] of read)
    if (result !== 'error' && packs?.includes(pack) === true) readPacks.set(pack, result);
  const value: FactoryCards = {
    projectId,
    // Cards read records once every pack has answered, so a card is never read under a pack
    // whose stages are still unknown and then read again.
    packs: packs !== null && packs.every(pack => read.has(pack)) ? readPacks : null,
    packsError: [...read.values()].some(result => result === 'error' || result.viewFailed),
    itemAsks,
  };
  return (
    <CardsContext.Provider value={value}>
      {(packs ?? []).map(pack => (
        <PackRead key={pack} projectId={projectId} pack={pack} onRead={onRead} />
      ))}
      {children}
    </CardsContext.Provider>
  );
}

/** The issue an item's key names whose title the card needs: none when the item has its own. */
function titleIssue(read: ItemRead): number[] {
  const number = issueNumber(read.item.key);
  return number === null || (read.item.title ?? '').trim() !== '' ? [] : [Number(number)];
}

/** What one card list reads: its cards' runs to read and the result keys their pointers name. */
function recordsAsk(packs: ReadonlyMap<string, CardPack>, reads: readonly ItemRead[]) {
  const runs = new Set<string>();
  const result = new Set<string>();
  for (const read of reads) {
    const pack = packOf(packs, read);
    for (const id of pack === null ? [] : runsToRead(pack, read)) runs.add(id);
    for (const key of pack?.view == null ? [] : resultKeys(pack.view)) result.add(key);
  }
  return { runs: [...runs].sort(), result: [...result] };
}

/** An entity's newest answer, or the last one while a changed key reads again. */
function useHeld<T>(data: T | null | undefined): T | null {
  const held = useRef<T | null>(null);
  if (data != null) held.current = data;
  return data ?? held.current;
}

/**
 * A forge read that fails leaves what it would have named unknown (titles, PR numbers) and the
 * rest of the card as read. The error goes to the console: the card still shows its key.
 */
async function forgeOrNull(
  query: Parameters<typeof getForgeSubjects>[0]
): Promise<ForgeSubjects | null> {
  try {
    return await getForgeSubjects(query);
  } catch (error) {
    console.warn('Board cards: the forge could not be read', error);
    return null;
  }
}

/** How long apart, and how often at most, a forge read with pending entries is read again. */
const PENDING_WAIT_MS = 2000;
const PENDING_READS = 30;

/**
 * A forge read under `key`, read again while the forge leaves anything pending. The server asks
 * the change host for one subject at a time and answers `pending` for a first lookup it could
 * not finish in time, so a board's older issues can stay pending for tens of seconds behind
 * the newer ones. What has answered is drawn meanwhile, and each re-read fills in more. After
 * `PENDING_READS` re-reads it stops and says so in the console; what is still pending then
 * shows its key, as with no forge answer.
 */
function useForgeRead(
  key: string,
  query: Parameters<typeof getForgeSubjects>[0] | null
): ForgeSubjects | null {
  const read = useEntity<ForgeSubjects | null>(key, () =>
    query === null ? Promise.resolve(null) : forgeOrNull(query)
  );
  const shown = useHeld(read.data);
  const reads = useRef(new Map<string, number>());
  const pending = read.data != null && forgePending(read.data);
  const { refetch } = read;
  useEffect(() => {
    if (!pending) return undefined;
    const count = reads.current.get(key) ?? 0;
    if (count >= PENDING_READS) {
      console.warn(
        `Board cards: the forge still answers pending after ${String(count)} re-reads`,
        key
      );
      return undefined;
    }
    const timer = setTimeout(() => {
      reads.current.set(key, count + 1);
      refetch();
    }, PENDING_WAIT_MS);
    return () => {
      clearTimeout(timer);
    };
    // `read.data` changes identity on every answer, which is what schedules the next re-read.
  }, [key, pending, read.data, refetch]);
  return shown;
}

/**
 * The issue titles the forge names for `reads` whose title column is empty: what a card prints
 * as its title, and what the board's filter searches (`itemMatches`). `projectId` null reads
 * nothing. Titles need only the item reads, so cards ask at once, beside the pack reads.
 */
export function useForgeTitles(
  projectId: string | null,
  reads: readonly ItemRead[]
): ForgeSubjects['issues'] | null {
  const issues = [...new Set(reads.flatMap(titleIssue))].sort((a, b) => a - b);
  const enabled = projectId !== null && issues.length > 0;
  return (
    useForgeRead(
      enabled ? K.forgeTitles(projectId, issues) : 'forge-titles:none',
      enabled ? { codebaseId: projectId, issues, changes: [] } : null
    )?.issues ?? null
  );
}

/**
 * The run records a list's cards need. While a changed list (a filter, "Show more", a run
 * starting) reads again, its last answer stays drawn: records are by run, so the held ones stay
 * true, and a run the held read was not asked for is not taken as unreadable.
 */
function useListRecords(
  projectId: string | null,
  ask: ReturnType<typeof recordsAsk>
): { records: ReadonlyMap<string, RunRecord>; asked: ReadonlySet<string> } {
  const enabled = projectId !== null && ask.runs.length > 0;
  const read = useEntity<RunRecords | null>(
    enabled ? K.cardReads(projectId, ask.runs) : 'factory-cards:none',
    () =>
      enabled
        ? getRunRecords(ask.runs, { output: OUTPUT_KEYS, result: ask.result })
        : Promise.resolve(null)
  );
  const held = useRef<{ data: RunRecords; runs: readonly string[] } | null>(null);
  if (read.data != null) held.current = { data: read.data, runs: ask.runs };
  const shown = read.data ?? held.current?.data ?? null;
  return {
    records: new Map((shown?.records ?? []).map(record => [record.id, record])),
    asked: new Set(
      read.data != null || read.error !== undefined ? ask.runs : (held.current?.runs ?? [])
    ),
  };
}

/** The forge's pull request numbers for the changes runs named, read once the records answer. */
function useForgeChanges(
  projectId: string | null,
  changes: readonly { run: string; url: string }[]
): ForgeSubjects['changes'] | null {
  const enabled = projectId !== null && changes.length > 0;
  return (
    useForgeRead(
      enabled ? K.forgeChanges(projectId, changes) : 'forge-changes:none',
      enabled ? { codebaseId: projectId, issues: [], changes } : null
    )?.changes ?? null
  );
}

/**
 * Each card's progress for a list of cards. Three reads, each drawn as soon as it answers: the
 * issue titles, the run records (rounds, returns, the running step, the PR), and then the
 * forge's numbers for the PRs those records name. Before they answer, and with no provider, a
 * card shows what its item read alone gives.
 */
export function useCardList(reads: readonly ItemRead[]): (read: ItemRead) => CardProgress {
  const cards = useFactoryCards();
  const projectId = cards?.projectId ?? null;
  const packs = cards?.packs ?? new Map<string, CardPack>();
  const issues = useForgeTitles(projectId, reads);
  // Records wait for the packs: which runs a card reads, and which result keys, come from
  // its pack's graph and view (`runsToRead`, `resultKeys`).
  const { records, asked } = useListRecords(
    cards?.packs == null ? null : projectId,
    recordsAsk(packs, reads)
  );
  const progressOf = (read: ItemRead, forge: ForgeSubjects | null): CardProgress => {
    // While the asks are read, or could not be, a card shows no button (its header no count).
    const ask = cards?.itemAsks;
    const asks = ask === undefined || typeof ask === 'string' ? [] : itemAsksOf(ask, read);
    const progress = cardProgress(read, packOf(packs, read), { records, asked, forge }, asks);
    return cards?.packsError === true ? { ...progress, unread: true } : progress;
  };
  const changes = reads.flatMap(read => {
    const pr = progressOf(read, null).pr;
    return pr?.run == null ? [] : [{ run: pr.run, url: pr.url }];
  });
  const numbers = useForgeChanges(projectId, changes);
  const forge = { issues: issues ?? [], changes: numbers ?? [] };
  return read => progressOf(read, forge);
}
