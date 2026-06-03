import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@archon/paths';
import { nodeArtifactSchema, type NodeArtifact } from './schemas/node-artifact';

/** Lazy logger (deferred so test mocks can intercept createLogger). */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('artifacts-index');
  return cachedLog;
}

/** Subdirectory under the artifacts dir holding per-node typed outputs + metadata. */
const NODES_SUBDIR = 'nodes';

/**
 * Restrict a node id to a single safe path segment for use in a filename.
 * Node ids are normally simple identifiers; this guards against a stray
 * separator or `..` escaping the nodes directory.
 */
function safeSegment(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Write a node's typed output artifact: the output text to `nodes/<id>.md`
 * and its metadata to `nodes/<id>.meta.json`. Per-node files (no shared index)
 * so concurrent nodes in a parallel layer never contend on one file.
 *
 * Returns the written metadata. Throws on fs failure — callers persist
 * artifacts best-effort and must wrap this in their own try/catch so a
 * metadata write never fails an otherwise-successful node.
 */
export async function writeNodeArtifact(
  artifactsDir: string,
  params: {
    nodeId: string;
    outputType: string;
    runId: string;
    producedAt: string;
    sessionId?: string;
  },
  outputText: string
): Promise<NodeArtifact> {
  const nodesDir = join(artifactsDir, NODES_SUBDIR);
  await mkdir(nodesDir, { recursive: true });
  const safeId = safeSegment(params.nodeId);
  const relPath = join(NODES_SUBDIR, `${safeId}.md`);
  await writeFile(join(artifactsDir, relPath), outputText, 'utf8');
  const meta: NodeArtifact = {
    nodeId: params.nodeId,
    outputType: params.outputType,
    path: relPath,
    runId: params.runId,
    producedAt: params.producedAt,
    size: Buffer.byteLength(outputText, 'utf8'),
    ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
  };
  await writeFile(join(nodesDir, `${safeId}.meta.json`), JSON.stringify(meta, null, 2), 'utf8');
  return meta;
}

/**
 * Read all typed-artifact metadata entries from an artifacts dir by globbing
 * the per-node `.meta.json` files (the index is derived on read, never a single
 * shared file). A missing dir yields `[]` (no artifacts yet — not an error);
 * an unreadable/corrupt entry is skipped with a warning, not fatal.
 */
export async function readNodeArtifacts(artifactsDir: string): Promise<NodeArtifact[]> {
  const nodesDir = join(artifactsDir, NODES_SUBDIR);
  let files: string[];
  try {
    files = await readdir(nodesDir);
  } catch {
    return [];
  }
  const out: NodeArtifact[] = [];
  for (const file of files) {
    if (!file.endsWith('.meta.json')) continue;
    const full = join(nodesDir, file);
    try {
      const parsed = nodeArtifactSchema.safeParse(JSON.parse(await readFile(full, 'utf8')));
      if (parsed.success) {
        out.push(parsed.data);
      } else {
        getLog().warn({ file: full }, 'artifacts.index_entry_invalid');
      }
    } catch (err) {
      getLog().warn({ file: full, err: err as Error }, 'artifacts.index_entry_read_failed');
    }
  }
  return out;
}

/**
 * Return the most-recently-produced artifact of a given `output_type`, or
 * `undefined` if none exists. ISO-8601 `producedAt` strings sort lexicographically.
 */
export async function latestNodeArtifactOfType(
  artifactsDir: string,
  outputType: string
): Promise<NodeArtifact | undefined> {
  const matching = (await readNodeArtifacts(artifactsDir)).filter(e => e.outputType === outputType);
  if (matching.length === 0) return undefined;
  return matching.reduce((latest, entry) =>
    entry.producedAt > latest.producedAt ? entry : latest
  );
}
