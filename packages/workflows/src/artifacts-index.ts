import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { createLogger, isPathInside, RUN_ARTIFACTS_ENGINE_SUBDIR } from '@archon/paths';
import {
  nodeArtifactSchema,
  type NodeArtifact,
  type NodeArtifactLoopFrame,
  type NodeArtifactReadError,
  type NodeArtifactReadResult,
  type NodeArtifactsListing,
} from './schemas/node-artifact';

/** Lazy logger (deferred so test mocks can intercept createLogger). */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('artifacts-index');
  return cachedLog;
}

/** Subdirectory under the artifacts dir holding per-node typed outputs + metadata. */
const NODES_SUBDIR = 'nodes';
/**
 * Engine-private subdirectory for per-invocation typed-artifact listings. Kept out
 * of `nodes/` so the reader never sees its own output, and inside the run's artifact
 * dir so containers that mount that dir read the same bytes at the same path.
 */
const LISTINGS_SUBDIR = join(RUN_ARTIFACTS_ENGINE_SUBDIR, 'typed-artifacts');
const nodeArtifactOwnerSchema = nodeArtifactSchema.pick({ nodeId: true, loopGroupPath: true });
const nodeArtifactWriteParamsSchema = nodeArtifactSchema.omit({ path: true, size: true });

type ArtifactOwner = Pick<NodeArtifact, 'nodeId' | 'loopGroupPath'>;

/**
 * Restrict a node id to a single safe path segment for use in a filename.
 * Node ids are normally simple identifiers; this guards against a stray
 * separator or `..` escaping the nodes directory.
 */
function safeSegment(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Build the single filename segment that identifies one typed node execution. */
function artifactStem(owner: ArtifactOwner): string {
  const nodeSegment = safeSegment(owner.nodeId);
  if (owner.loopGroupPath === undefined) return nodeSegment;

  // The dot makes loop stems disjoint from top-level safeSegment() output. Hash
  // the canonical original owner so valid ids containing our display separators
  // cannot alias one another; readable provenance remains in the metadata.
  const canonicalOwner = [
    owner.nodeId,
    owner.loopGroupPath.map(frame => [frame.groupId, frame.iteration]),
  ];
  const digest = createHash('sha256').update(JSON.stringify(canonicalOwner)).digest('hex');
  return `loop.${digest}__${nodeSegment}`;
}

function sameLoopGroupPath(
  left: NodeArtifactLoopFrame[] | undefined,
  right: NodeArtifactLoopFrame[] | undefined
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.length === right.length &&
    left.every(
      (frame, index) =>
        frame.groupId === right[index]?.groupId && frame.iteration === right[index]?.iteration
    )
  );
}

function sameArtifactOwner(left: ArtifactOwner, right: ArtifactOwner): boolean {
  return left.nodeId === right.nodeId && sameLoopGroupPath(left.loopGroupPath, right.loopGroupPath);
}

/**
 * Read the owner recorded in an existing `.meta.json`, or `undefined` if the
 * file is missing or corrupt. Used only by the collision guard in
 * `writeNodeArtifact`. Real filesystem failures remain visible to the caller.
 */
async function readArtifactOwner(metaPath: string): Promise<ArtifactOwner | undefined> {
  let rawMetadata: string;
  try {
    rawMetadata = await readFile(metaPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }

  try {
    const parsed = nodeArtifactOwnerSchema.safeParse(JSON.parse(rawMetadata));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write a node's typed output artifact: the output text and metadata under
 * `nodes/`. Top-level nodes retain `nodes/<id>.md` + `<id>.meta.json`; a
 * loop_group body execution qualifies that identity with a stable digest of its
 * structured owner and records the readable ordered frames in metadata.
 * Per-execution files (no shared index): the index is derived on read by globbing,
 * so separate nodes, iterations, and runs never overwrite one another's metadata.
 * Concurrent writers are isolated by their identity-derived paths.
 *
 * Returns the written metadata. Throws on fs failure or a sanitized-id collision
 * — callers persist artifacts best-effort and must wrap this in their own
 * try/catch so an artifact write never fails an otherwise-successful node.
 */
export async function writeNodeArtifact(
  artifactsDir: string,
  params: Omit<NodeArtifact, 'path' | 'size'>,
  outputText: string
): Promise<NodeArtifact> {
  // Zod refinements such as positive iteration and non-empty lineage are not
  // represented in the inferred TypeScript primitives, so enforce them at the
  // durable constructor before creating either sidecar.
  const parsedParams = nodeArtifactWriteParamsSchema.parse(params);
  const nodesDir = join(artifactsDir, NODES_SUBDIR);
  await mkdir(nodesDir, { recursive: true });
  const owner: ArtifactOwner = {
    nodeId: parsedParams.nodeId,
    ...(parsedParams.loopGroupPath !== undefined
      ? { loopGroupPath: parsedParams.loopGroupPath }
      : {}),
  };
  const stem = artifactStem(owner);
  const metaPath = join(nodesDir, `${stem}.meta.json`);

  // Collision guard: top-level safeSegment() can collapse distinct node ids (for
  // example `a.b` and `a_b`), and loop digests retain an ownership check rather
  // than assuming their hash alone is authoritative. Compare the complete
  // producer identity and fail loudly instead of overwriting another artifact.
  const priorOwner = await readArtifactOwner(metaPath);
  if (priorOwner !== undefined && !sameArtifactOwner(priorOwner, owner)) {
    throw new Error(
      `node artifact id collision: distinct producers both map to filename segment '${stem}'`
    );
  }

  const relPath = join(NODES_SUBDIR, `${stem}.md`);
  await writeFile(join(artifactsDir, relPath), outputText, 'utf8');
  const meta: NodeArtifact = {
    nodeId: parsedParams.nodeId,
    outputType: parsedParams.outputType,
    ...(parsedParams.loopGroupPath !== undefined
      ? { loopGroupPath: parsedParams.loopGroupPath }
      : {}),
    path: relPath,
    runId: parsedParams.runId,
    producedAt: parsedParams.producedAt,
    size: Buffer.byteLength(outputText, 'utf8'),
    ...(parsedParams.sessionId !== undefined ? { sessionId: parsedParams.sessionId } : {}),
  };
  await writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  return meta;
}

export type NodeArtifactReadScope =
  | { readonly scope: 'current-run'; readonly runId: string }
  | { readonly scope: 'resolved-scope' };

/**
 * Read all typed-artifact metadata entries from an artifacts dir by globbing
 * the per-node `.meta.json` files (the index is derived on read, never a single
 * shared file). A missing dir yields an empty result (no artifacts yet — not an
 * error). Every other failure is reported in `errors` alongside the valid entries,
 * never thrown and never silently dropped.
 *
 * `current-run` lookup requires the expected run ID: a sidecar written by another
 * run is reported as `foreign_run` and is not returned as an artifact. The
 * cold-resume caller instead reads an already-resolved scope directory
 * (`resolved-scope`) and does its own prior-run filtering.
 */
export async function readNodeArtifacts(
  artifactsDir: string,
  readScope: NodeArtifactReadScope
): Promise<NodeArtifactReadResult> {
  const nodesDir = join(artifactsDir, NODES_SUBDIR);
  const errors: NodeArtifactReadError[] = [];
  // A Map, not a plain object: `output_type` is an open string, and a plain record
  // indexed by a key such as `__proto__` resolves an inherited property, so the
  // accumulator write below would throw. `Object.fromEntries` defines each entry as
  // an own data property, so such a type survives serialization as a normal key.
  const artifactsByType = new Map<string, NodeArtifact[]>();
  const empty: NodeArtifactReadResult = { artifactsByType: {}, errors };

  let files: string[];
  try {
    files = (await readdir(nodesDir)).sort();
  } catch (err) {
    // ENOENT = the nodes dir was never created → no artifacts yet, not an error.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return empty;
    getLog().warn({ nodesDir, err: err as Error }, 'artifacts.nodes_dir_read_failed');
    errors.push(
      withCode({ path: NODES_SUBDIR, kind: 'unreadable_directory' }, err as NodeJS.ErrnoException)
    );
    return empty;
  }

  // Containment is checked against the run dir's real path, so a symlinked `nodes/`
  // or a sidecar pointing outside the run can never hand a consumer an outside file.
  let realRoot: string;
  try {
    realRoot = await realpath(artifactsDir);
  } catch (err) {
    errors.push(withCode({ path: '', kind: 'unreadable_directory' }, err as NodeJS.ErrnoException));
    return empty;
  }
  // The directory itself is not a file, so it cannot go through
  // `classifyContainedFile` (which insists on a regular file). A `nodes/` symlink
  // that points outside the run is rejected here; one that stays inside is fine,
  // and every file opened below is re-checked on its own resolved path.
  let realNodes: string;
  try {
    realNodes = await realpath(nodesDir);
  } catch (err) {
    errors.push(
      withCode({ path: NODES_SUBDIR, kind: 'unreadable_directory' }, err as NodeJS.ErrnoException)
    );
    return empty;
  }
  if (!isPathInside(realRoot, realNodes)) {
    errors.push({ path: NODES_SUBDIR, kind: 'unsafe_path' });
    return empty;
  }

  for (const file of files) {
    if (!file.endsWith('.meta.json')) continue;
    const metaRel = portable(join(NODES_SUBDIR, file));
    const full = join(nodesDir, file);

    const metaCheck = await classifyContainedFile(artifactsDir, realRoot, full);
    if (metaCheck.status === 'unsafe') {
      errors.push({ path: metaRel, kind: 'unsafe_path' });
      continue;
    }
    if (metaCheck.status === 'missing' || metaCheck.status === 'unreadable') {
      errors.push({ path: metaRel, kind: 'unreadable_metadata', code: metaCheck.code });
      continue;
    }

    let rawMetadata: string;
    try {
      rawMetadata = await readFile(full, 'utf8');
    } catch (err) {
      errors.push(
        withCode({ path: metaRel, kind: 'unreadable_metadata' }, err as NodeJS.ErrnoException)
      );
      continue;
    }

    const parsed = parseArtifact(rawMetadata);
    if (parsed === undefined) {
      errors.push({ path: metaRel, kind: 'invalid_metadata' });
      continue;
    }
    if (readScope.scope === 'current-run' && parsed.runId !== readScope.runId) {
      errors.push({ path: metaRel, kind: 'foreign_run' });
      continue;
    }

    // An escaped content pointer is rejected outright: the metadata is not a
    // trustworthy description of a file this run owns. A content file that is
    // merely missing or unreadable keeps its valid metadata and adds a diagnostic,
    // so the reader can still name what the artifact was.
    const contentCheck = await classifyContainedFile(
      artifactsDir,
      realRoot,
      join(artifactsDir, parsed.path)
    );
    if (contentCheck.status === 'unsafe') {
      errors.push({ path: metaRel, kind: 'unsafe_path' });
      continue;
    }
    if (contentCheck.status === 'missing') {
      errors.push({ path: metaRel, kind: 'missing_content', code: contentCheck.code });
    } else if (contentCheck.status === 'unreadable') {
      errors.push({ path: metaRel, kind: 'unreadable_content', code: contentCheck.code });
    }

    const existing = artifactsByType.get(parsed.outputType);
    if (existing !== undefined) existing.push(parsed);
    else artifactsByType.set(parsed.outputType, [parsed]);
  }

  for (const entries of artifactsByType.values()) {
    entries.sort((left, right) => {
      // Numeric, not lexicographic: `…00Z` and `…00.000Z` are the same instant but
      // different strings. Equal instants keep a deterministic order by content path,
      // which is one-to-one with the sidecar path that produced the entry.
      const delta = Date.parse(left.producedAt) - Date.parse(right.producedAt);
      return delta !== 0 ? delta : left.path.localeCompare(right.path);
    });
  }
  return { artifactsByType: Object.fromEntries(artifactsByType), errors };
}

function parseArtifact(rawMetadata: string): NodeArtifact | undefined {
  let value: unknown;
  try {
    value = JSON.parse(rawMetadata);
  } catch {
    return undefined;
  }
  const parsed = nodeArtifactSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Portable `/`-separated form of a path for wire/diagnostic output. */
function portable(path: string): string {
  return path.split(sep).join('/');
}

function withCode(
  error: NodeArtifactReadError,
  err: NodeJS.ErrnoException | undefined
): NodeArtifactReadError {
  return err?.code ? { ...error, code: err.code } : error;
}

type ContainedFile =
  | { status: 'ok' }
  | { status: 'unsafe' }
  | { status: 'missing'; code: string }
  | { status: 'unreadable'; code?: string };

/**
 * Classify a path the reader is about to open: it must resolve to a regular file
 * inside the run dir, both lexically and after following links.
 */
async function classifyContainedFile(
  root: string,
  realRoot: string,
  candidate: string
): Promise<ContainedFile> {
  if (!isPathInside(root, candidate)) return { status: 'unsafe' };
  let real: string;
  try {
    real = await realpath(candidate);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { status: 'missing', code };
    return code ? { status: 'unreadable', code } : { status: 'unreadable' };
  }
  if (!isPathInside(realRoot, real)) return { status: 'unsafe' };
  try {
    if (!(await stat(real)).isFile()) return { status: 'unsafe' };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code ? { status: 'unreadable', code } : { status: 'unreadable' };
  }
  return { status: 'ok' };
}

/**
 * Write a per-invocation listing of the current run's readable typed artifacts.
 *
 * Each call writes a unique file: a consumer invocation observes the artifacts
 * published before it, and a later invocation must not overwrite an earlier one's
 * observation. Returns the absolute path to hand to the invocation. A write failure
 * propagates — an invocation that cannot see its listing is a provisioning error,
 * never an empty listing.
 */
export async function writeNodeArtifactsListing(
  artifactsDir: string,
  runId: string
): Promise<string> {
  const result = await readNodeArtifacts(artifactsDir, { scope: 'current-run', runId });
  const listing: NodeArtifactsListing = { runId, ...result };
  const listingDir = join(artifactsDir, LISTINGS_SUBDIR);
  await mkdir(listingDir, { recursive: true });
  const listingPath = join(listingDir, `${randomUUID()}.json`);
  await writeFile(listingPath, JSON.stringify(listing, null, 2), 'utf8');
  return listingPath;
}
