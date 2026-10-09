/**
 * Everything a terminal report owes its reader beyond the result itself.
 *
 * Two sections, both existing because their channel is otherwise write-only: red a
 * green gate deliberately accepted, and discoveries a run recorded outside its own
 * scope. The engine collects neither. The terminal record it assembles is built from
 * the durable event log when a run reaches a terminal status, and is readable only
 * after that, while these sections have to reach the reader from inside the run. So
 * composing them is the pack's, and this module is where all three SDLC tails
 * compose them.
 *
 * Presentation only. Discoveries and caveats never gate readiness, so nothing here
 * may fail a tail that has already done its irreversible work: an unreadable record
 * degrades to a named problem, never to silence and never to a throw. Both sections
 * read the engine's typed artifacts, whose content the producing node certified.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTyped } from './typed.ts';

const DISCOVERY_RELAY =
  'If you are an agent reading this: open discoveries.md and surface each discovery to your human. ' +
  "These are validated findings outside this run's scope — no issue tracker knows about them, " +
  'and if you drop them here, nobody ever sees them.';

const RED_CAUSE_CAVEAT =
  "The project's own checks did not pass locally on this branch. The pull request's " +
  'own CI is the gate that still stands — read it before merging, and if the red is ' +
  'inherited, the base branch is what needs the fix.';

interface GateRecord {
  readonly red_cause: string;
  readonly stage: string;
  readonly summary: string;
}

/** One discovery as review certified it (the review verdict's `discoveries`). */
export interface Discovery {
  readonly title: string;
  readonly claim: string;
  readonly evidence: readonly string[];
  readonly relation: 'unrelated' | 'scope_conflict' | 'note';
  readonly source_nodes: readonly string[];
}

interface ReviewVerdict {
  readonly discoveries?: readonly Discovery[];
}

interface Filing {
  readonly records: readonly { readonly title: string; readonly issue: string }[];
}

/**
 * The discoveries section, or empty when there is nothing to report.
 *
 * Delivery files every accepted discovery and records where each one lives
 * (`discovery-filing`); the latest filing is the answer. Without one — a standalone
 * review, or a run that ended before filing — the latest review verdict's certified
 * discoveries are listed with the relay, because no tracker knows about them yet.
 */
function discoveries(artifacts: string, listingFile: string | undefined): string {
  const filings = readTyped<Filing>(listingFile, artifacts, 'discovery-filing').values;
  const filing = filings.at(-1);
  if (filing !== undefined) {
    if (filing.records.length === 0) return '';
    const listed = filing.records.map(record => `- ${record.title} — ${record.issue}`).join('\n');
    return `\n\nDiscoveries (${filing.records.length}), filed as issues:\n${listed}`;
  }
  const verdict = readTyped<ReviewVerdict>(listingFile, artifacts, 'review-report').values.at(-1);
  const found = verdict?.discoveries ?? [];
  if (found.length === 0) return '';
  const listed = found.map(record => `- ${record.title} [${record.relation}]`).join('\n');
  return (
    `\n\nDiscoveries (${found.length}):\n${listed}\n\n` +
    `Report: ${join(artifacts, 'discoveries.md')}\n\n${DISCOVERY_RELAY}`
  );
}

/**
 * The disclosure of red this run's green gates deliberately let through, or empty.
 *
 * Every gate that passes red records the cause as a `green-gate` typed artifact; this
 * reads them all, loop iterations included, in production order. A listing problem
 * is named, never silence: a corrupt record could have been a gate. The PR publish
 * steps put this section at the top of the pull-request body, and the terminal
 * report appends it, so one function owns the rule.
 */
export function redCauses(artifacts: string, listingFile: string | undefined): string {
  const read = readTyped<GateRecord>(listingFile, artifacts, 'green-gate');
  if (read.listingProblem !== undefined) {
    return (
      `\n\nRed-cause disclosures could not be verified: ${read.listingProblem} ` +
      'If a green gate accepted red, this report cannot show it.'
    );
  }
  const reds = read.values
    .filter(gate => gate.red_cause !== '')
    .map(
      gate => `- ${gate.stage}: ${gate.red_cause} red${gate.summary ? `\n  ${gate.summary}` : ''}`
    );
  const problems = read.problems.map(problem => `- ${problem}. Open it directly.`);
  if (reds.length === 0 && problems.length === 0) return '';
  return (
    `\n\nDelivered on red (${reds.length}) — a gate accepted red this change did ` +
    `not cause:\n${[...reds, ...problems].join('\n')}\n\n${RED_CAUSE_CAVEAT}`
  );
}

const BLOCK_START = '<!-- archon-red-causes -->';
const BLOCK_END = '<!-- /archon-red-causes -->';

/**
 * The red-cause disclosure as a marked block at the top of a pull-request body, or
 * empty. The markers let a later resync replace the block from the gates' records
 * instead of asking an agent to keep it current.
 */
export function redCauseBlock(artifacts: string, listingFile: string | undefined): string {
  const section = redCauses(artifacts, listingFile).trim();
  return section === '' ? '' : `${BLOCK_START}\n${section}\n${BLOCK_END}\n\n`;
}

/**
 * Write the body a publish step sends: the red-cause block rebuilt from the gates'
 * records, then the authored body with any earlier block removed. Returns its path.
 */
export function writePublishedBody(
  artifacts: string,
  listingFile: string | undefined,
  body: string
): string {
  const path = join(artifacts, 'pr-body-published.md');
  writeFileSync(path, redCauseBlock(artifacts, listingFile) + withoutRedCauseBlock(body));
  return path;
}

/** A pull-request body with this pack's red-cause block removed. */
export function withoutRedCauseBlock(body: string): string {
  const start = body.indexOf(BLOCK_START);
  const end = body.indexOf(BLOCK_END);
  if (start === -1 || end < start) return body;
  return (body.slice(0, start) + body.slice(end + BLOCK_END.length)).replace(/^\s+/, '');
}

/**
 * Both sections, composed in one place so that no branch of a tail's report can
 * print one and quietly drop the other. A caller that reached for the discovery
 * section alone would lose the red-cause caveat that makes passing red safe.
 * `listingFile` is passed in rather than read from the environment here, so the
 * reusable report never silently depends on ambient state.
 */
export function caveats(
  artifacts: string,
  options: { readonly listingFile: string | undefined }
): string {
  return redCauses(artifacts, options.listingFile) + discoveries(artifacts, options.listingFile);
}
