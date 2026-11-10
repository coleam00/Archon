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
import { decodePrPublicationRecord, PR_CREATE_RECORD, PR_CREATE_UNRESOLVED, RUN_FAILED } from './pr.ts';
import { isObject } from './io.ts';
import { latestOutcomeOf, readOutcomes } from './outcomes.ts';
import { outputsOf, type RunOutput, type RunOutputs } from './outputs.ts';

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

/** The latest review verdict a run produced: its records, and when the review completed. */
export interface LatestVerdict {
  readonly discoveries: readonly unknown[];
  /** Milliseconds since the epoch. */
  readonly at: number;
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
    if (at === undefined || (verdict !== undefined && at <= verdict.at)) continue;
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
 * The verdict a run's latest `review-report` output is, for the relay rule. A verdict
 * that declares no discoveries list consolidated none, so it judged no raw record
 * either: every raw record stands, as when no review ran.
 */
function verdictFrom(output: RunOutput<unknown> | undefined): LatestVerdict | undefined {
  const discoveries = isObject(output?.value) ? output.value.discoveries : undefined;
  return output !== undefined && Array.isArray(discoveries)
    ? { discoveries, at: Date.parse(output.producedAt) }
    : undefined;
}

/**
 * Another run's latest review verdict, from what was read of its `review-report`
 * outputs. Throws when one of them could not be read, so a caller never mistakes an
 * unreadable review for none.
 */
export function latestVerdictOf(
  read: Extract<RunOutputs<unknown>, { state: 'read' }>
): LatestVerdict | undefined {
  const unread = read.problems[0];
  if (unread !== undefined) throw new Error(unread);
  return verdictFrom(read.outputs.at(-1));
}

/** The discoveries section, or empty when there is nothing to report. */
function discoveries(artifacts: string, run: string | undefined): string {
  const read = outputsOf<unknown>(run, 'review-report');
  if (read.state !== 'read') {
    return `\n\nDiscoveries could not be listed: ${read.problem}. Open ${join(artifacts, 'discoveries.md')} and ${join(artifacts, 'discoveries')} directly.`;
  }
  const relayed = relayedDiscoveries(artifacts, verdictFrom(read.outputs.at(-1)));
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
 * The report's closing section. `run`, this run's id, is passed in rather than read from
 * the environment here, so the reusable report never silently depends on ambient state.
 */
export function caveats(artifacts: string, options: { readonly run: string | undefined }): string {
  return discoveries(artifacts, options.run);
}

/** A verified publication can outlive a failed node with no typed output. */
function createdPr(artifacts: string): { url: string; unresolved?: true; problem?: string } {
  const path = join(artifacts, PR_CREATE_RECORD);
  try {
    const claim = decodePrPublicationRecord(JSON.parse(readFileSync(path, 'utf8')));
    return claim.state === 'verified' ? { url: claim.pr.url } : { url: '', unresolved: true };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { url: '' };
    return {
      url: '',
      unresolved: true,
      problem: `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export interface ReportListings {
  /** This run's id, for its typed outputs. */
  readonly run: string | undefined;
  readonly outcomesFile: string | undefined;
}

/**
 * The pull request a failed run already published. The latest typed publication
 * stands while its publish node's latest invocation did not fail. When a later
 * invocation failed, or none published, the creation record decides: a publish node
 * can verify a PR and then fail, and its failed output is never handed on. An
 * unresolved creation claim must not look like permission to open another PR.
 */
export function failedPublication(
  artifacts: string,
  options: ReportListings
): { reason: string; pr_url: string } {
  const read = outputsOf<unknown>(options.run, 'pull-request');
  const entry = read.state === 'read' ? read.outputs.at(-1) : undefined;
  const latest = entry?.value;
  const created = createdPr(artifacts);
  const typedUrl = isObject(latest) && typeof latest.url === 'string' ? latest.url : '';
  // Unreadable outcomes leave the creation record to decide, as a later failure would.
  const publish =
    typedUrl !== '' && entry !== undefined
      ? latestOutcomeOf(readOutcomes(options.outcomesFile) ?? [], entry)
      : undefined;
  if (publish !== undefined && publish.state !== 'failed') return { reason: RUN_FAILED, pr_url: typedUrl };
  if (created.unresolved) return { reason: PR_CREATE_UNRESOLVED, pr_url: '' };
  return { reason: RUN_FAILED, pr_url: created.url || typedUrl };
}

/**
 * The summary a tail's report node writes when a node failure kept the run from
 * reaching its outcome. It names no result: the engine's terminal record names the
 * failed node, and nothing here may read as a delivery.
 */
export function failed(artifacts: string, options: ReportListings): string {
  const { problem } = createdPr(artifacts);
  const unresolved = failedPublication(artifacts, options).reason === PR_CREATE_UNRESOLVED;
  return (
    'Not done: a node failed before this run reported its result. The run\'s terminal record names the node and its error. ' +
    'Anything the run already published, such as a pushed branch or a pull request, is left as it is.' +
    (!unresolved ? '' : `\n\nReconcile the PR create recorded at ${join(artifacts, PR_CREATE_RECORD)} before continuing; its identity may not have been saved.`) +
    (problem ? `\n\n${problem}` : '') +
    caveats(artifacts, options)
  );
}
