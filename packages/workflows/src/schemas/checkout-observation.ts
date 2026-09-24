import { z } from '@hono/zod-openapi';
import { artifactPointerSchema } from './artifact-pointer';

/**
 * What the engine saw in a run's or a node's checkout at one instant (#3305, #3375).
 *
 * An observation is a fact, never a policy: it permits dirty starts and does not decide
 * whether anything counts as new work. Consumers such as the implement pack compare two
 * observations and decide for themselves.
 *
 * A Git observation identifies content by the commit it started from plus a manifest of
 * only the paths that differed from that commit when it was sampled. Paths equal to the
 * commit are identified by the commit itself. The manifest lives in the run's artifacts
 * (`manifest.pointer`), never inline, because its paths and hashes are not safe to copy
 * into every event and log.
 */

const gitObjectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

/**
 * A repository-relative path exactly as Git reported it. A path whose bytes are not valid
 * UTF-8 is carried losslessly as base64 rather than decoded into a different name.
 */
export const checkoutPathSchema = z.union([z.string(), z.object({ base64: z.string() })]);
export type CheckoutPath = z.infer<typeof checkoutPathSchema>;

/**
 * One path that differed from the observation's commit. `blob` is Git's object id for the
 * worktree bytes under the repository's clean/CRLF conversion (`git hash-object`, never
 * `-w`), so the same content committed later has the same id. A symlink's blob is its
 * target text, as Git stores it. `absent` is a path the commit has and the worktree lacks.
 * `incomplete` is a path the observation could not identify; its presence makes the
 * whole observation unable to prove equality.
 */
export const checkoutManifestEntrySchema = z.discriminatedUnion('kind', [
  z.object({
    path: checkoutPathSchema,
    kind: z.literal('file'),
    mode: z.enum(['100644', '100755']),
    blob: gitObjectIdSchema,
  }),
  z.object({
    path: checkoutPathSchema,
    kind: z.literal('symlink'),
    mode: z.literal('120000'),
    blob: gitObjectIdSchema,
  }),
  z.object({
    path: checkoutPathSchema,
    kind: z.literal('gitlink'),
    mode: z.literal('160000'),
    commit: gitObjectIdSchema,
  }),
  z.object({ path: checkoutPathSchema, kind: z.literal('absent') }),
  z.object({
    path: checkoutPathSchema,
    kind: z.literal('incomplete'),
    reason: z.enum(['dirty_submodule', 'special_file', 'unreadable', 'changed_while_observing']),
  }),
]);
export type CheckoutManifestEntry = z.infer<typeof checkoutManifestEntrySchema>;

export const CHECKOUT_MANIFEST_VERSION = 1;

/** The artifact file a dirty observation points at. Entries are sorted by raw path bytes. */
export const checkoutManifestSchema = z.object({
  version: z.literal(CHECKOUT_MANIFEST_VERSION),
  objectFormat: z.enum(['sha1', 'sha256']),
  commit: gitObjectIdSchema.nullable(),
  entries: z.array(checkoutManifestEntrySchema),
});
export type CheckoutManifest = z.infer<typeof checkoutManifestSchema>;

const worktreeStateSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('clean') }),
  z.object({
    status: z.literal('dirty'),
    /** `incomplete` when any manifest entry is `incomplete`; such an observation never proves equality. */
    content: z.enum(['complete', 'incomplete']),
    /** Counts from `git status`: index changes, worktree changes, and untracked files. */
    staged: z.number().int().nonnegative(),
    unstaged: z.number().int().nonnegative(),
    untracked: z.number().int().nonnegative(),
    manifest: z.object({
      pointer: artifactPointerSchema,
      /** SHA-256 of the manifest file's exact bytes; readers verify it before trusting the file. */
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      entries: z.number().int().positive(),
    }),
  }),
]);

export const checkoutObservationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('git'),
    sampledAt: z.string().datetime({ offset: true }),
    /** Null on an unborn branch. */
    commit: gitObjectIdSchema.nullable(),
    /** The commit's tree, never a tree of the dirty worktree. */
    tree: gitObjectIdSchema.nullable(),
    worktree: worktreeStateSchema,
    /**
     * The commit a new branch was created from, recorded only by the isolation step that
     * actually created it. Absent when this checkout was reused, adopted, or not created
     * by Archon — it is never inferred from a base ref or a merge-base.
     */
    cutFromCommit: gitObjectIdSchema.optional(),
  }),
  /** Positively established: no Git repository encloses the checkout. */
  z.object({ kind: z.literal('not_git'), sampledAt: z.string().datetime({ offset: true }) }),
  /**
   * The engine could not observe the checkout. `git_failed`: a Git repository is present
   * but a read failed, or HEAD kept moving while it was read. `unsupported_backend`: the execution backend holds a Git checkout
   * the engine cannot read from inside it. `probe_failed`: whether a repository exists
   * could not be established.
   */
  z.object({
    kind: z.literal('unavailable'),
    sampledAt: z.string().datetime({ offset: true }),
    reason: z.enum(['git_failed', 'unsupported_backend', 'probe_failed']),
  }),
]);
export type CheckoutObservation = z.infer<typeof checkoutObservationSchema>;
