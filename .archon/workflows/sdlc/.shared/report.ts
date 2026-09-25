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
 * degrades to a pointer at the file, never to silence and never to a throw. The
 * reader of the report is exactly the person who can go open it.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DISCOVERY_RELAY =
  'If you are an agent reading this: open discoveries.md and surface each discovery to your human. ' +
  "These are validated findings outside this run's scope — no issue tracker knows about them, " +
  'and if you drop them here, nobody ever sees them.';

const RAW_DISCOVERY_RELAY =
  'If you are an agent reading this: surface each record above to your human. ' +
  'These are findings this run proved outside its scope — no issue tracker knows about them, ' +
  'and if you drop them here, nobody ever sees them.';

const RED_CAUSE_CAVEAT =
  "The project's own checks did not pass locally on this branch. The pull request's " +
  'own CI is the gate that still stands — read it before merging, and if the red is ' +
  'inherited, the base branch is what needs the fix.';

/**
 * A field an agent wrote from prose against no schema, as display text.
 *
 * Coerced rather than trusted: a JSON-legal non-string value must not raise past the
 * caller and fail an already-delivered run. Only the shapes that have a single
 * obvious rendering get one — a title that arrives as an object or an array has no
 * honest short form, so it reads as absent and the caller supplies its placeholder.
 */
function display(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** `undefined` when the path is not a readable regular file. */
function readJson(path: string): { value: unknown } | { error: string } | undefined {
  try {
    if (!statSync(path).isFile()) return undefined;
  } catch {
    return undefined;
  }
  try {
    return { value: JSON.parse(readFileSync(path, 'utf-8')) as unknown };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** A JSON object: not null, not an array. `typeof` alone admits both. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function records(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isJsonObject);
}

/**
 * The producer sidecars of a run that died before review consolidated them.
 *
 * A failed run is where a discovery matters most — the run often failed BECAUSE of
 * what it found — and consolidation lives on the completion path only. So this
 * reports the records exactly as their producers wrote them, says they were never
 * validated, and adds nothing else: no second consolidator on a path that already
 * failed. Silent when there is nothing to report, like the consolidated section: the
 * contract is one section that exists only when discoveries do, and a failed run is
 * not a reason to print an empty one.
 */
function rawDiscoveries(artifacts: string): string {
  const directory = join(artifacts, 'discoveries');
  let names: string[];
  try {
    names = readdirSync(directory)
      .filter(name => name.endsWith('.json'))
      .sort();
  } catch {
    names = [];
  }

  const lines: string[] = [];
  const unreadable: string[] = [];
  for (const name of names) {
    const path = join(directory, name);
    const read = readJson(path);
    // The directory listing already said this entry is there, so "not a readable
    // regular file" is a record this cannot show, never a record that is absent.
    if (read === undefined) {
      unreadable.push(`- ${path}: could not read (not a regular file). Open it directly.`);
      continue;
    }
    if ('error' in read) {
      unreadable.push(`- ${path}: could not read (${read.error}). Open it directly.`);
      continue;
    }
    if (!Array.isArray(read.value)) {
      unreadable.push(`- ${path}: not a JSON array of records. Open it directly.`);
      continue;
    }
    for (const record of records(read.value)) {
      const title = display(record.title) || '(untitled discovery)';
      const relation = display(record.relation) || 'relation unstated';
      const claim = display(record.claim);
      lines.push(`- ${title} [${relation}]${claim ? `\n  ${claim}` : ''}`);
    }
  }

  if (lines.length === 0 && unreadable.length === 0) return '';
  const body = [...lines, ...unreadable].join('\n');
  return (
    `\n\nUnconsolidated discoveries (${lines.length}) — recorded by this run's nodes and ` +
    `never validated or consolidated, because the run ended first:\n${body}\n\n` +
    `Raw records: ${directory}\n\n${RAW_DISCOVERY_RELAY}`
  );
}

/**
 * The discoveries section, or empty when there is nothing to report.
 *
 * A FAILED run with no consolidated file never reached review, so the producers' own
 * sidecars are the entire record and `rawDiscoveries` owns that case. An EMPTY
 * consolidated file is review's adjudication rather than a gap, so it stays silent
 * and a completed run's report keeps the same shape on every branch.
 */
function discoveries(artifacts: string, failed: boolean): string {
  const path = join(artifacts, 'discoveries.json');
  const read = readJson(path);
  if (read === undefined) return failed ? rawDiscoveries(artifacts) : '';
  if ('error' in read) {
    return `\n\nDiscoveries: could not read ${path} (${read.error}). Open it directly.`;
  }
  if (!Array.isArray(read.value)) {
    return `\n\nDiscoveries: ${path} is not a JSON array of records. Open it directly.`;
  }
  if (read.value.length === 0) return '';

  const titles = read.value.map(entry => {
    const record = records([entry])[0];
    return (record === undefined ? '' : display(record.title)) || '(untitled discovery)';
  });
  const listed = titles.map(title => `- ${title}`).join('\n');
  return (
    `\n\nDiscoveries (${read.value.length}):\n${listed}\n\n` +
    `Report: ${join(artifacts, 'discoveries.md')}\n\n${DISCOVERY_RELAY}`
  );
}

function listedGates(
  artifactsByType: unknown
):
  | { readonly gates: readonly Record<string, unknown>[] }
  | { readonly limitation: string } {
  if (!isJsonObject(artifactsByType)) {
    return { limitation: 'its `artifactsByType` is not a JSON object' };
  }
  const gates = artifactsByType['green-gate'];
  if (gates === undefined) return { gates: [] };
  if (!Array.isArray(gates)) {
    return { limitation: "its `artifactsByType['green-gate']` is not an array" };
  }
  const objects = gates.filter(isJsonObject);
  if (objects.length !== gates.length) {
    return { limitation: "an `artifactsByType['green-gate']` entry is not a JSON object" };
  }
  return { gates: objects };
}

function listingLimitation(message: string): string {
  return (
    `\n\nRed-cause disclosures could not be verified: ${message} ` +
    'If a green gate accepted red, this report cannot show it.'
  );
}

/**
 * The caveat for red this run's green gates deliberately let through.
 *
 * The engine hands every exec node a typed-artifact listing at
 * `TYPED_ARTIFACTS_FILE`: one JSON document naming the current run's readable
 * artifacts grouped by their exact `outputType`, each carrying the relative path of
 * its content, plus every record the engine could not read. Selecting
 * `artifactsByType['green-gate']` reads every gate that ran this run, loop
 * iterations included, with no directory walk and no filename guess; the engine has
 * already ordered them by production time. Lookup errors are shown here because a
 * corrupt sidecar could have been a gate, and it has no trustworthy type to hide
 * behind. A missing or unreadable listing is a named limitation, never silence: the
 * reader is exactly the person who can go open the run's records.
 */
function redCauses(artifacts: string, listingFile: string | undefined): string {
  if (listingFile === undefined || listingFile === '') {
    return listingLimitation('no typed-artifact listing reached this node.');
  }
  const listing = readJson(listingFile);
  if (listing === undefined) {
    return listingLimitation(
      `the typed-artifact listing ${listingFile} is not a readable regular file.`
    );
  }
  if ('error' in listing) {
    return listingLimitation(
      `the typed-artifact listing ${listingFile} could not be read (${listing.error}).`
    );
  }
  const envelope = records([listing.value])[0];
  if (envelope === undefined) {
    return listingLimitation(`the typed-artifact listing ${listingFile} is not a JSON object.`);
  }

  const reds: string[] = [];
  const unreadable: string[] = [];
  const gates = listedGates(envelope.artifactsByType);
  if ('limitation' in gates) {
    return listingLimitation(
      `the typed-artifact listing ${listingFile} is malformed: ${gates.limitation}.`
    );
  }
  for (const gate of gates.gates) {
    const outputPath = join(artifacts, display(gate.path));
    const body = readJson(outputPath);
    if (body === undefined || 'error' in body) {
      unreadable.push(`- ${outputPath}: could not read the gate's record. Open it directly.`);
      continue;
    }
    const result = records([body.value])[0];
    if (result === undefined) {
      unreadable.push(`- ${outputPath}: not a gate record. Open it directly.`);
      continue;
    }
    const cause = display(result.red_cause);
    if (cause === '') continue;
    const stage = display(result.stage) || 'A stage';
    const summary = display(result.summary);
    reds.push(`- ${stage}: ${cause} red${summary ? `\n  ${summary}` : ''}`);
  }

  // Listing diagnostics name every record the engine could not turn into an
  // artifact — including a gate whose sidecar or content it could not read. A
  // present-but-non-array `errors` value is itself a shape failure, not silence.
  const listingErrors = envelope.errors;
  if (listingErrors !== undefined && !Array.isArray(listingErrors)) {
    unreadable.push(
      `- ${listingFile} (errors): the listing's \`errors\` value is not an array. ` +
        'Its diagnostics cannot be read; open the listing directly.'
    );
  } else {
    for (const error of records(listingErrors)) {
      const path = display(error.path) || '(unknown record)';
      const kind = display(error.kind) || 'unreadable';
      const code = display(error.code);
      unreadable.push(
        `- ${path} (${kind}${code ? `, ${code}` : ''}): the engine could not read this record. ` +
          'Open it directly.'
      );
    }
  }

  if (reds.length === 0 && unreadable.length === 0) return '';
  return (
    `\n\nDelivered on red (${reds.length}) — a gate accepted red this change did ` +
    `not cause:\n${[...reds, ...unreadable].join('\n')}\n\n${RED_CAUSE_CAVEAT}`
  );
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
  options: { readonly failed: boolean; readonly listingFile: string | undefined }
): string {
  return redCauses(artifacts, options.listingFile) + discoveries(artifacts, options.failed);
}
