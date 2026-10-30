import { createHash } from 'crypto';
import { readdir, readFile, writeFile } from 'fs/promises';
import { join, sep } from 'path';
import { z } from 'zod';
import { sourceUnitSchema, indexedInstalledPluginSchema, validateUnitIndex } from './unit-index';
import { workflowSourceConfigSchema } from '../schemas/workflow-run';
import { installedPluginRecordSchema } from './installed-packs';
import { WorkflowSourceIntegrityError, isSystemError, sourceReadError } from './integrity';
import {
  BUNDLED_SCOPE_DIR,
  GLOBAL_SCOPE_DIR,
  INSTALLED_SCOPE_DIR,
  PROJECT_SCOPE_DIR,
  type WorkflowSourceAnchor,
} from './roots';

const MANIFEST_FILE = 'manifest.json';

/**
 * What a capture records about itself.
 *
 * `digest` is the reason this file exists. A directory that merely EXISTS proves nothing
 * about the bytes inside it: a partial restore, an interrupted sync, or an edit under the
 * artifacts tree would all pass an existence check while changing what the run executes.
 * Recomputing the digest on load is what makes the capture authoritative rather than
 * merely present.
 *
 * `engine_version` is recorded, never enforced. It lets someone reading a run afterwards
 * tell "this resumed under a different Archon" apart from "this changed" — including for
 * the bundled scope a binary embeds rather than copies.
 *
 * `workflow_name` is stamped after selection (see {@link recordSelectedWorkflow}), because
 * the capture is taken BEFORE discovery. That ordering is what stops a run executing one
 * moment's YAML against another moment's scripts.
 */
const manifestFields = {
  engine_version: z.string(),
  origin: z.string(),
  captured_at: z.string(),
  digest: z.string(),
  file_count: z.number(),
  byte_count: z.number(),
  scopes: z.array(
    z.enum([PROJECT_SCOPE_DIR, GLOBAL_SCOPE_DIR, BUNDLED_SCOPE_DIR, INSTALLED_SCOPE_DIR])
  ),
  source_config: workflowSourceConfigSchema,
  /** Absent until the caller has selected which workflow this run executes. */
  workflow_name: z.string().optional(),
  /**
   * Entrypoint names of installed packs that could not be read at capture. The packs are
   * left out, so only workflows that name them fail; discovery still reserves the names
   * so a same-named project or global workflow cannot stand in for them.
   */
  unavailable_installed_workflows: z.array(z.string()).optional(),
};

/** Legacy captures authenticate the aggregate payload; v3 authenticates a unit index. */
export const workflowSourceManifestSchema = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), ...manifestFields }),
  z.object({
    version: z.literal(2),
    ...manifestFields,
    installed_plugins: z.array(installedPluginRecordSchema).min(1),
  }),
  z
    .object({
      version: z.literal(3),
      ...manifestFields,
      digest: z.string().regex(/^[a-f0-9]{64}$/),
      file_count: z.number().int().nonnegative().safe(),
      byte_count: z.number().int().nonnegative().safe(),
      source_config: workflowSourceConfigSchema.strict(),
      installed_plugins: z.array(indexedInstalledPluginSchema),
      units: z.array(sourceUnitSchema),
    })
    .strict()
    .superRefine(validateUnitIndex),
]);

export type WorkflowSourceManifest = z.infer<typeof workflowSourceManifestSchema>;
export type IndexedWorkflowSourceManifest = Extract<WorkflowSourceManifest, { version: 3 }>;

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonicalJsonValue(entry)])
    );
  }
  return value;
}

/** workflow_name is a diagnostic stamp; every other header field is authenticated. */
export function indexedSourceDigest(manifest: IndexedWorkflowSourceManifest): string {
  const { digest: _digest, workflow_name: _workflowName, ...immutable } = manifest;
  return createHash('sha256')
    .update('archon-workflow-source-v3\0')
    .update(JSON.stringify(canonicalJsonValue(immutable)))
    .digest('hex');
}

/** Where a run's executable source came from, and what was frozen. */
export interface WorkflowSourceCapture {
  /** The authoring directory this was captured from. */
  origin: string;
  manifest: WorkflowSourceManifest;
  /** Pinned identity retained for every later filesystem-backed read. */
  anchor: WorkflowSourceAnchor;
}

/** One captured file's contribution to the capture digest. */
export interface DigestEntry {
  /** Capture-relative path, platform separator. */
  readonly relPath: string;
  /** sha256 of the file's bytes, hex. */
  readonly hash: string;
}

export interface SizedDigestEntry extends DigestEntry {
  readonly size: number;
}

/**
 * Fold per-file digests into the capture's digest.
 *
 * Path-and-bytes, sorted, so the value depends only on what was captured and never on
 * walk order or timestamps. The sort compares the platform-separated path and the hash
 * takes the `/`-normalized one; both halves are load-bearing for compatibility, because a
 * capture written by an older build is re-verified by this function and any change to
 * either would read as tampering. The manifest is excluded because it carries this value.
 */
export function foldDigest(entries: readonly DigestEntry[]): string {
  const hash = createHash('sha256');
  const sorted = [...entries].sort((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0
  );
  for (const entry of sorted) {
    hash.update(entry.relPath.split(sep).join('/'));
    hash.update('\0');
    hash.update(entry.hash);
    hash.update('\n');
  }
  return hash.digest('hex');
}

/**
 * Hash every file under `root`, reading each one.
 *
 * `skipScope` names a top-level scope directory whose per-file digests the caller already
 * holds — the bundled scope, written from bytes this process is still holding. Everything
 * else is read here, which is what makes the digest a statement about bytes, not paths.
 */
export async function digestEntries(root: string, skipScope?: string): Promise<SizedDigestEntry[]> {
  const entries: SizedDigestEntry[] = [];

  const walk = async (dir: string, rel: string): Promise<void> => {
    const dirEntries = await readdir(dir, { withFileTypes: true });
    for (const entry of dirEntries) {
      const relPath = rel === '' ? entry.name : join(rel, entry.name);
      if (entry.isDirectory()) {
        if (rel === '' && entry.name === skipScope) continue;
        await walk(join(dir, entry.name), relPath);
      } else if (entry.isFile()) {
        if (relPath === MANIFEST_FILE) continue;
        const content = await readFile(join(dir, entry.name));
        entries.push({
          relPath,
          hash: createHash('sha256').update(content).digest('hex'),
          size: content.length,
        });
      }
    }
  };
  await walk(root, '');

  return entries;
}

export async function writeManifest(
  captureRoot: string,
  manifest: WorkflowSourceManifest
): Promise<void> {
  await writeFile(join(captureRoot, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function readManifest(captureRoot: string): Promise<WorkflowSourceManifest> {
  let raw: string;
  try {
    raw = await readFile(join(captureRoot, MANIFEST_FILE), 'utf-8');
  } catch (error) {
    if (isSystemError(error) && error.code === 'EISDIR') {
      throw new WorkflowSourceIntegrityError(
        `Workflow source manifest at ${captureRoot} is a directory`,
        join(captureRoot, MANIFEST_FILE)
      );
    }
    throw sourceReadError(join(captureRoot, MANIFEST_FILE), error);
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    throw new WorkflowSourceIntegrityError(
      `Workflow source manifest at ${captureRoot} is not valid JSON: ${(error as Error).message}`,
      join(captureRoot, MANIFEST_FILE)
    );
  }
  const parsed = workflowSourceManifestSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new WorkflowSourceIntegrityError(
      `Workflow source manifest at ${captureRoot} is not a shape this build understands: ${parsed.error.message}`,
      join(captureRoot, MANIFEST_FILE)
    );
  }
  return parsed.data;
}
