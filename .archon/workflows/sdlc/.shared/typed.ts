/**
 * Read this run's typed artifacts of one type, in the order the engine produced them.
 *
 * The engine hands every exec node a listing at `TYPED_ARTIFACTS_FILE`: the current
 * run's artifacts grouped by their exact `output_type`, each with the path of its
 * content relative to `ARTIFACTS_DIR`, ordered by production time, plus every record
 * it could not read. A typed artifact's content is the producing node's certified
 * output, so a reader trusts its shape. What can still go wrong is reading it: a
 * missing listing, an unreadable content file, an engine diagnostic. Those come back
 * as `problems` for the caller to name, never as silence.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** One listed artifact's identity: the node that produced it and its loop position. */
export interface ListedArtifact {
  readonly path: string;
  readonly nodeId?: string;
  readonly loopGroupPath?: readonly { readonly groupId: string; readonly iteration: number }[];
}

export interface TypedRead<T> {
  readonly values: readonly T[];
  /** The listed artifacts the values were read from, in the same order. */
  readonly entries?: readonly ListedArtifact[];
  /** Records of this type, or engine diagnostics, that could not be read. */
  readonly problems: readonly string[];
  /** Set when the listing itself is missing or malformed: nothing in it can be trusted. */
  readonly listingProblem?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readTyped<T>(
  listingFile: string | undefined,
  artifacts: string,
  type: string
): TypedRead<T> {
  const fail = (listingProblem: string): TypedRead<T> => ({ values: [], problems: [], listingProblem });
  if (listingFile === undefined || listingFile === '') {
    return fail('no typed-artifact listing reached this node.');
  }
  let listing: unknown;
  try {
    listing = JSON.parse(readFileSync(listingFile, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return fail(`the typed-artifact listing ${listingFile} could not be read (${reason}).`);
  }
  // The listing is the engine's, read across a boundary this pack cannot import
  // types over, so its envelope is checked rather than assumed.
  if (!isObject(listing) || !isObject(listing.artifactsByType)) {
    return fail(`the typed-artifact listing ${listingFile} is malformed: no artifactsByType object.`);
  }
  const entries = listing.artifactsByType[type] ?? [];
  if (!Array.isArray(entries) || !entries.every(entry => isObject(entry) && typeof entry.path === 'string')) {
    return fail(`the typed-artifact listing ${listingFile} is malformed: its ${type} entries are not records.`);
  }
  const values: T[] = [];
  const problems: string[] = [];
  const listed: ListedArtifact[] = entries as ListedArtifact[];
  for (const entry of listed) {
    const path = join(artifacts, entry.path);
    try {
      values.push(JSON.parse(readFileSync(path, 'utf8')) as T);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      problems.push(`${path}: could not read this ${type} record (${reason})`);
    }
  }
  const errors = listing.errors ?? [];
  if (!Array.isArray(errors)) {
    problems.push(`${listingFile}: the listing's \`errors\` value is not an array, so its diagnostics cannot be read`);
  } else {
    for (const error of errors.filter(isObject)) {
      const code = typeof error.code === 'string' ? `, ${error.code}` : '';
      problems.push(
        `${typeof error.path === 'string' ? error.path : '(unknown record)'} (${typeof error.kind === 'string' ? error.kind : 'unreadable'}${code}): the engine could not read this record`
      );
    }
  }
  return { values, problems, entries: listed };
}
