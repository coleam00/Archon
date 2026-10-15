/**
 * What a terminal report owes its reader beyond the result itself: the discoveries
 * a run recorded outside its own scope.
 *
 * The channel is otherwise write-only. The engine does not collect discoveries, and
 * the terminal record it assembles is readable only after a run reaches a terminal
 * status, while this section has to reach the reader from inside the run. So
 * composing it is the pack's, and this module is where all three SDLC tails compose
 * it.
 *
 * Presentation only. Discoveries never gate readiness, so nothing here may fail a
 * tail that has already done its irreversible work: an unreadable record degrades to
 * a named problem, never to silence and never to a throw. It reads the engine's typed
 * artifacts, whose content the producing node certified.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readTyped } from './typed.ts';

const DISCOVERY_RELAY =
  'If you are an agent reading this: surface each discovery to your human. ' +
  "These are validated findings outside this run's scope — no issue tracker knows about them, " +
  'and if you drop them here, nobody ever sees them.';

/** One discovery as review certified it (the review verdict's `discoveries`). */
interface Discovery {
  readonly title: string;
  readonly relation: 'unrelated' | 'scope_conflict' | 'note';
}

interface ReviewVerdict {
  readonly discoveries?: readonly Discovery[];
}

function modified(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Raw records under discoveries/ written after `since`, or all of them when no review
 * consolidated any. The last review judged every earlier record (and may have rejected
 * some); a node that ran after it — the structure pass, its implementer, or a planner
 * whose run stopped before delivery — wrote records no review saw.
 */
function unconsolidated(artifacts: string, since: number | undefined): string[] {
  const dir = join(artifacts, 'discoveries');
  let names: string[];
  try {
    names = readdirSync(dir).filter(name => name.endsWith('.json'));
  } catch {
    return [];
  }
  const lines: string[] = [];
  for (const name of names.sort()) {
    const path = join(dir, name);
    const at = modified(path);
    if (at === undefined || (since !== undefined && at <= since)) continue;
    try {
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!Array.isArray(value)) throw new Error('not a JSON array of records');
      for (const entry of value as unknown[]) {
        const title = typeof entry === 'object' && entry !== null ? (entry as { title?: unknown }).title : undefined;
        lines.push(`- ${typeof title === 'string' && title.trim() !== '' ? title.trim() : '(untitled discovery)'} [unreviewed]`);
      }
    } catch (error) {
      lines.push(`- could not read ${path} (${error instanceof Error ? error.message : String(error)}). Open it directly.`);
    }
  }
  return lines;
}

/**
 * The discoveries section, or empty when there is nothing to report.
 *
 * Nothing files discoveries: the latest review verdict's certified records are listed,
 * with any raw record a node wrote after that review, and the relay asks whoever reads
 * the report to surface them.
 */
function discoveries(artifacts: string, listingFile: string | undefined): string {
  const read = readTyped<ReviewVerdict>(listingFile, artifacts, 'review-report');
  if (read.listingProblem !== undefined) {
    return `\n\nDiscoveries could not be listed: ${read.listingProblem} Open ${join(artifacts, 'discoveries.md')} and ${join(artifacts, 'discoveries')} directly.`;
  }
  const latest = read.entries?.at(-1);
  const since = latest === undefined ? undefined : modified(join(artifacts, latest.path));
  const lines = [
    ...(read.values.at(-1)?.discoveries ?? []).map(record => `- ${record.title} [${record.relation}]`),
    ...unconsolidated(artifacts, since),
  ];
  if (lines.length === 0) return '';
  return (
    `\n\nDiscoveries:\n${lines.join('\n')}\n\n` +
    `Records: ${join(artifacts, 'discoveries.md')}, ${join(artifacts, 'discoveries')}\n\n${DISCOVERY_RELAY}`
  );
}

/**
 * The report's closing section. `listingFile` is passed in rather than read from the
 * environment here, so the reusable report never silently depends on ambient state.
 */
export function caveats(
  artifacts: string,
  options: { readonly listingFile: string | undefined }
): string {
  return discoveries(artifacts, options.listingFile);
}

/**
 * The summary a tail's report node writes when a node failure kept the run from
 * reaching its outcome. It names no result: the engine's terminal record names the
 * failed node, and nothing here may read as a delivery.
 */
export function failed(
  artifacts: string,
  options: { readonly listingFile: string | undefined }
): string {
  return (
    'Not done: a node failed before this run reported its result. The run\'s terminal record names the node and its error. ' +
    'Anything the run already published, such as a pushed branch or a pull request, is left as it is.' +
    caveats(artifacts, options)
  );
}
