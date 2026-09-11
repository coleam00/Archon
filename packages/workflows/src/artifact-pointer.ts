/**
 * Artifact pointers (#2453) — the one reserved shape a workflow result may use to point
 * at a file instead of carrying it.
 *
 * A workflow that produces something large (a plan, a report, a diff) already writes it
 * under `$ARTIFACTS_DIR` and returns a small structured summary. Until now the file's
 * location was a naming convention: nothing tied the summary to the file, and nothing
 * checked that the location a result named was one the run could actually address.
 *
 * A pointer is an ordinary `JsonValue` carrying a reserved discriminator:
 *
 * ```json
 * { "type": "archon_artifact", "run_id": "01J…", "path": "plan.md" }
 * ```
 *
 * The rule is settled at the PRODUCER, against its OWN run, once: the node that emits the
 * value (an AI node, a loop iteration, a certified `bash:`/`script:` stdout) proves that
 * every pointer names this run and a regular file that exists, lexically, under this run's
 * artifacts directory. A pointer naming any other run is rejected — a result may only point
 * at its own run's artifacts today. The value then travels unchanged: a `workflow:` parent
 * and a fan-out aggregate relay the child's value without re-validating it, because the
 * child already certified it against the only run it can address.
 *
 * The READ side owns reachability and real-path checks by design: whether a reader may
 * see the named run, and whether the path still resolves inside that run's artifacts
 * directory once symlinks are followed, are decided when the file is read — by a future
 * in-workflow resolver, the terminal run record, or `GET /api/artifacts/:runId/<path>`.
 * Today that route does lexical containment only; real-path resolution at read time is
 * not yet implemented (#3160). Producer-time `realpath` would not be a guarantee — the
 * tree can change between the producing node and any read — so it is deliberately not
 * attempted here.
 *
 * The value stays a run id plus a RELATIVE path everywhere — in events, in APIs, and on a
 * resumed run. The engine never expands it into an absolute path and never loads the file.
 */
import { stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { z } from 'zod';
import { getRunArtifactsDirForRoot, isInsideArchonHome } from '@archon/paths';
import type { WorkflowRun } from './schemas';

/** Reserved `type` discriminator. An object carrying it MUST be a valid pointer. */
export const ARTIFACT_POINTER_TYPE = 'archon_artifact';

/**
 * The pointer shape. Unknown sibling keys are tolerated (an author may label a pointer for
 * their own downstream code); the three engine-owned fields are not optional.
 */
export const artifactPointerSchema = z.object({
  type: z.literal(ARTIFACT_POINTER_TYPE),
  run_id: z.string().min(1),
  path: z.string().min(1),
});

export type ArtifactPointer = z.infer<typeof artifactPointerSchema>;

/** One tagged object found inside a value, with the JSON path that located it. */
interface TaggedCandidate {
  at: string;
  value: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Collect every object tagged with the reserved discriminator, at any depth. Cheap and
 * allocation-free for the overwhelmingly common case of a value with no pointers at all,
 * which is what lets every producer call this without paying for a disk read.
 */
function collectTagged(value: unknown, at: string, found: TaggedCandidate[]): void {
  if (Array.isArray(value)) {
    value.forEach((element, index) => {
      collectTagged(element, `${at}[${String(index)}]`, found);
    });
    return;
  }
  if (!isPlainObject(value)) return;
  if (value.type === ARTIFACT_POINTER_TYPE) {
    found.push({ at, value });
    // A pointer's own fields are strings; nothing nested to walk.
    return;
  }
  for (const [key, child] of Object.entries(value)) collectTagged(child, `${at}.${key}`, found);
}

/**
 * Why one pointer was rejected, phrased to complete a sentence beginning with the failing
 * node's identity: `Node 'plan': <reason>.`
 */
async function checkPointer(
  candidate: TaggedCandidate,
  currentRun: WorkflowRun
): Promise<string | null> {
  const parsed = artifactPointerSchema.safeParse(candidate.value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return (
      `the value at ${candidate.at} is tagged '${ARTIFACT_POINTER_TYPE}' but is not a valid artifact pointer (${issues}). ` +
      `An artifact pointer is { "type": "${ARTIFACT_POINTER_TYPE}", "run_id": <this run's id>, "path": <path relative to this run's artifacts directory> }`
    );
  }
  const pointer = parsed.data;
  const where = `the artifact pointer at ${candidate.at} (run '${pointer.run_id}', path '${pointer.path}')`;

  // Path shape first: it is decided by the value alone, so a malformed path is reported
  // the same way whichever run it names.
  if (pointer.path.includes('\0')) return `${where} contains a NUL byte in its path`;
  if (isAbsolute(pointer.path) || pointer.path.startsWith('/') || pointer.path.startsWith('\\')) {
    return `${where} must use a path relative to this run's artifacts directory, not an absolute one`;
  }
  if (pointer.path.split(/[\\/]/).includes('..')) {
    return `${where} may not contain '..' path segments`;
  }

  if (pointer.run_id !== currentRun.id) {
    return (
      `${where} names another run — a result may only point at its own run's artifacts today ` +
      `(this run is '${currentRun.id}')`
    );
  }

  // The artifacts location comes from this run's own persisted `output_root`, so a renamed
  // codebase keeps resolving (#1192) and a run that never recorded one is simply
  // unaddressable — the same limit `$ADOPTED_RUN_DIR` has. The home check is the trust
  // rule every reader of a persisted root applies: the engine only ever writes an in-tree
  // value, so an out-of-tree one is a hand edit that must not steer a containment check.
  const outputRoot = currentRun.output_root;
  if (outputRoot === null || outputRoot.trim() === '') {
    return `${where} cannot be addressed because this run's artifacts location was never recorded (output_root is null)`;
  }
  if (!isInsideArchonHome(outputRoot)) {
    return `${where} cannot be addressed because this run's recorded artifacts location is outside the Archon home directory`;
  }

  const root = normalize(getRunArtifactsDirForRoot(outputRoot, currentRun.id));
  const full = normalize(join(root, pointer.path));
  if (!full.startsWith(root + sep)) {
    return `${where} resolves outside this run's artifacts directory`;
  }

  // Lexical containment plus existence. Real-path resolution belongs to the read side by
  // design and is not implemented anywhere yet (#3160); see the module comment.
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(full);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return `${where} refers to a file that does not exist under this run's artifacts directory`;
    }
    return `${where} could not be checked: ${(error as Error).message}`;
  }
  if (!stats.isFile()) {
    return `${where} does not refer to a regular file`;
  }
  // A pointer is evidence the producer offers for its result. An empty file carries
  // none, so it is refused here rather than by every consumer that would otherwise
  // have to re-check the one thing the contract already promised.
  if (stats.size === 0) {
    return `${where} refers to an empty file; a pointer must name evidence`;
  }
  return null;
}

/**
 * Validate every artifact pointer inside one logical value at the producing node,
 * immediately before that value is persisted and becomes readable downstream.
 *
 * Returns `null` when the value carries no pointer or every pointer is valid, and the
 * rejection reason otherwise. A reason, not a throw: the producers that call this each have
 * their own failure convention (a thrown contract error, a `failResult`, a `failLoopNode`),
 * and the message is written to complete `Node '<id>': <reason>.`
 */
export async function validateArtifactPointers(
  value: unknown,
  currentRun: WorkflowRun
): Promise<string | null> {
  const found: TaggedCandidate[] = [];
  collectTagged(value, '$', found);
  for (const candidate of found) {
    const rejection = await checkPointer(candidate, currentRun);
    if (rejection !== null) return rejection;
  }
  return null;
}
