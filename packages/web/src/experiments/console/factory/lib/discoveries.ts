/**
 * The words of the board's "Found by the factory" panel and the Overview's tile, from what
 * the discoveries drains decided (`GET /api/factory/discoveries`). A finding an item on the
 * project already carries (by title) is on the board, so only the others count.
 */
import type { FactoryDiscoveries } from '../../skills/factory';

/** One finding a drain decided to file. */
export type FactoryFinding = FactoryDiscoveries['findings'][number];

/** The panel's id: the board's `?show=found` address opens on it. */
export const FOUND_BY_THE_FACTORY = 'found-by-the-factory';

/** The panel's name, and the heading of a discoveries run's panel in an item's story. */
export const FOUND_BY_THE_FACTORY_LABEL = 'Found by the factory';

/** The findings no item on the project carries yet. */
export function openFindings(read: FactoryDiscoveries): FactoryFinding[] {
  return read.findings.filter(finding => finding.coveredBy === null);
}

interface FoundChip {
  label: string;
  count: number;
}

/**
 * "would file N · held N · dropped N": every decision the drains made, a finding an item
 * covers since included. A shadow drain files nothing, so it would file.
 */
export function foundChips(read: FactoryDiscoveries): FoundChip[] {
  return [
    { label: read.shadow ? 'would file' : 'filed', count: read.findings.length },
    { label: 'held', count: read.held },
    { label: 'dropped', count: read.dropped },
  ];
}

/** The pack's kind in sentence case ("defect" reads "Defect"); null reads nothing. */
export function kindLabel(kind: string | null): string | null {
  if (kind === null || kind.trim() === '') return null;
  const words = kind.trim().replace(/[-_]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
