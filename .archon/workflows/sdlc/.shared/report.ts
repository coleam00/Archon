/**
 * The discoveries a run recorded outside its own scope: which records a run relays,
 * and the terminal report's section that lists them.
 *
 * A run's discoveries are the latest review verdict's certified records, plus any raw
 * record under `discoveries/` that a node wrote after that review, or every raw
 * record when no review ran. The last review judged every earlier raw record and may
 * have rejected some, so a rejected record is never raised again. The terminal report
 * and the discoveries workflow read the same set through `relayedDiscoveries`.
 *
 * The report is presentation only. Discoveries never gate readiness, so nothing in it
 * may fail a tail that has already done its irreversible work: an unreadable record
 * degrades to a named problem, never to silence and never to a throw.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PR_CREATE_RECORD, PR_CREATE_VERIFIED_RECORD } from './pr.ts';
import { isObject, readTyped } from './typed.ts';

const DISCOVERY_RELAY =
  'If you are an agent reading this: surface each discovery to your human. ' +
  "These are validated findings outside this run's scope; the pack's discoveries workflow drains them " +
  'into issues only where a project runs it, so if you drop them here, nobody may ever see them.';

/** One discovery record a run relays, with a reference stable within its run. */
export interface DiscoveryRecord {
  /** `review#<index>` for a certified record, `discoveries/<file>#<index>` for a raw one. */
  readonly ref: string;
  readonly title: string;
  readonly claim: string;
  readonly evidence: readonly string[];
  /** The review's relation for a certified record; whatever the producer wrote, or null, for a raw one. */
  readonly relation: string | null;
  readonly reviewed: boolean;
}

export interface RelayedDiscoveries {
  readonly records: readonly DiscoveryRecord[];
  /** Records that could not be read, each naming its file. */
  readonly problems: readonly string[];
}

/** The latest review verdict a run produced: its records, and when it was written. */
export interface LatestVerdict {
  readonly discoveries: readonly unknown[];
  /** Milliseconds since the epoch; undefined when its time is unknown. */
  readonly at: number | undefined;
}

function modified(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  return value === undefined || value === null ? '' : JSON.stringify(value);
}

function asRecord(value: unknown, ref: string, reviewed: boolean): DiscoveryRecord {
  const entry = isObject(value) ? value : {};
  const evidence = Array.isArray(entry.evidence)
    ? entry.evidence.map(asText)
    : asText(entry.evidence) === ''
      ? []
      : [asText(entry.evidence)];
  return {
    ref,
    title: asText(entry.title) || '(untitled discovery)',
    claim: asText(entry.claim),
    evidence,
    relation: typeof entry.relation === 'string' ? entry.relation : null,
    reviewed,
  };
}

/**
 * The records a run relays, given its latest review verdict (undefined when no review
 * ran). Raw records are read from `<artifacts>/discoveries/*.json`.
 */
export function relayedDiscoveries(
  artifacts: string,
  verdict: LatestVerdict | undefined
): RelayedDiscoveries {
  const records: DiscoveryRecord[] = (verdict?.discoveries ?? []).map((entry, index) =>
    asRecord(entry, `review#${String(index)}`, true)
  );
  const problems: string[] = [];
  const dir = join(artifacts, 'discoveries');
  let names: string[];
  try {
    names = readdirSync(dir).filter(name => name.endsWith('.json'));
  } catch {
    names = [];
  }
  for (const name of names.sort()) {
    const path = join(dir, name);
    const at = modified(path);
    if (at === undefined || (verdict?.at !== undefined && at <= verdict.at)) continue;
    try {
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
      // A producer that had one record sometimes wrote it bare rather than in an array.
      const entries = Array.isArray(value) ? value : isObject(value) ? [value] : undefined;
      if (entries === undefined) throw new Error('not a JSON array of records');
      entries.forEach((entry: unknown, index) => {
        records.push(asRecord(entry, `discoveries/${name}#${String(index)}`, false));
      });
    } catch (error) {
      problems.push(`could not read ${path} (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return { records, problems };
}

/**
 * Another run's latest review verdict, located by type in its `nodes/*.meta.json`
 * sidecars, the engine's record of each typed output. Throws when a sidecar or the
 * verdict cannot be read, so a caller never mistakes an unreadable review for none.
 */
export function latestVerdictOf(artifacts: string): LatestVerdict | undefined {
  const dir = join(artifacts, 'nodes');
  let names: string[];
  try {
    names = readdirSync(dir).filter(name => name.endsWith('.meta.json'));
  } catch {
    return undefined;
  }
  let latest: { path: string; at: number } | undefined;
  for (const name of names) {
    const meta: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    if (!isObject(meta) || meta.outputType !== 'review-report') continue;
    const at = typeof meta.producedAt === 'string' ? Date.parse(meta.producedAt) : Number.NaN;
    if (typeof meta.path !== 'string' || Number.isNaN(at)) {
      throw new Error(`${join(dir, name)} names no content path and production time`);
    }
    if (latest === undefined || at > latest.at) latest = { path: meta.path, at };
  }
  if (latest === undefined) return undefined;
  const content = join(artifacts, latest.path);
  const value: unknown = JSON.parse(readFileSync(content, 'utf8'));
  if (!isObject(value)) throw new Error(`${content} is not a review verdict`);
  return verdictFrom(value, content);
}

/**
 * The verdict a review-report value is, for the relay rule. A verdict that declares
 * no discoveries list consolidated none, so it judged no raw record either: every raw
 * record stands, as when no review ran.
 */
function verdictFrom(value: unknown, content: string): LatestVerdict | undefined {
  const discoveries = isObject(value) ? value.discoveries : undefined;
  return Array.isArray(discoveries) ? { discoveries, at: modified(content) } : undefined;
}

/** This run's latest review verdict, from the engine's typed-artifact listing. */
function latestVerdictFromListing(
  artifacts: string,
  listingFile: string | undefined
): { verdict: LatestVerdict | undefined } | { listingProblem: string } {
  const read = readTyped<unknown>(listingFile, artifacts, 'review-report');
  if (read.listingProblem !== undefined) return { listingProblem: read.listingProblem };
  const entry = read.entries?.at(-1);
  if (entry === undefined) return { verdict: undefined };
  return { verdict: verdictFrom(read.values.at(-1), join(artifacts, entry.path)) };
}

/** The discoveries section, or empty when there is nothing to report. */
function discoveries(artifacts: string, listingFile: string | undefined): string {
  const latest = latestVerdictFromListing(artifacts, listingFile);
  if ('listingProblem' in latest) {
    return `\n\nDiscoveries could not be listed: ${latest.listingProblem} Open ${join(artifacts, 'discoveries.md')} and ${join(artifacts, 'discoveries')} directly.`;
  }
  const relayed = relayedDiscoveries(artifacts, latest.verdict);
  const lines = [
    ...relayed.records.map(
      record => `- ${record.title} [${record.reviewed ? (record.relation ?? 'unrelated') : 'unreviewed'}]`
    ),
    ...relayed.problems.map(problem => `- ${problem}. Open it directly.`),
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

/** A create verified before a later description edit failed has no typed output. */
function creationRecord(path: string): { url: string; at?: number; problem?: string } {
  try {
    const claim: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const pr = isObject(claim) ? claim.pr : undefined;
    return { url: isObject(pr) && typeof pr.url === 'string' ? pr.url : '', at: modified(path) };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { url: '' };
    return { url: '', problem: `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function createdPr(artifacts: string): { url: string; at?: number; problem?: string } {
  const records = [PR_CREATE_RECORD, PR_CREATE_VERIFIED_RECORD].map(name => creationRecord(join(artifacts, name)));
  const latest = records.filter(record => record.url !== '').sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).at(-1);
  const problems = records.flatMap(record => record.problem === undefined ? [] : [record.problem]);
  return { url: latest?.url ?? '', at: latest?.at, problem: problems.length === 0 ? undefined : problems.join('\n\n') };
}

/**
 * The URL of the pull request this run last published, from the engine's
 * typed-artifact listing or its verified creation records, ordered by artifact write
 * time; empty when it published none. A tail that failed after publishing still names its pull request, so the next run continues that one
 * instead of opening another. An unreadable listing is named by `failed`'s summary.
 */
export function publishedPrUrl(
  artifacts: string,
  options: { readonly listingFile: string | undefined }
): string {
  const read = readTyped<unknown>(options.listingFile, artifacts, 'pull-request');
  const latest = read.values.at(-1);
  const entry = read.entries?.at(-1);
  const created = createdPr(artifacts);
  const publishedAt = entry === undefined ? undefined : modified(join(artifacts, entry.path));
  if (isObject(latest) && typeof latest.url === 'string' &&
    (created.url === '' || (publishedAt ?? 0) >= (created.at ?? 0))) return latest.url;
  return created.url;
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
  const { problem } = createdPr(artifacts);
  return (
    'Not done: a node failed before this run reported its result. The run\'s terminal record names the node and its error. ' +
    'Anything the run already published, such as a pushed branch or a pull request, is left as it is.' +
    (problem ? `\n\n${problem}` : '') +
    caveats(artifacts, options)
  );
}
