import {
  configureWorktreeIsolation,
  createRunWorktreeSetupExecutor,
  type WorktreeSetupDeps,
} from './worktree-setup';
/**
 * Child-isolation resolver factory (#2121 slice 2, PR-A).
 *
 * Constructs the {@link ChildIsolationResolver} port the workflow engine calls once
 * per `workflow:` child whose node declares `isolation: 'worktree'`. Lives in
 * `@archon/core` — the layer that already depends on BOTH `@archon/workflows` (the
 * port TYPE) and `@archon/isolation` (`WorktreeProvider`) — so the port stays
 * isolation-free (`@archon/workflows` never imports `@archon/isolation`) AND every
 * injection site (CLI, orchestrator, continuation and resource start) builds it
 * through {@link createCodebaseChildResolver}, which owns the folder-project policy.
 *
 * Creates a fresh `archon/task-<parent>-<node>-<hash>-child-<i>` branch through
 * {@link createRegisteredWorktree}, the recipe every launch path shares, so standard
 * `isolation list`/`cleanup`/`complete` hygiene applies to child worktrees.
 */

import type {
  ChildIsolationResolver,
  ChildIsolationRequest,
  ChildIsolationResult,
} from '@archon/workflows/executor';
import { createHash } from 'node:crypto';
import * as git from '@archon/git';
import { createLogger } from '@archon/paths';
import type { IIsolationStore } from '@archon/isolation';
import type { Codebase } from '../schemas/codebase';
import { createRegisteredWorktree } from './registered-worktree';

/**
 * How much of the node id goes into the branch name verbatim. `WorktreeProvider`
 * slugifies the identifier and truncates it to 50 chars, so the readable part has
 * to be bounded — see {@link buildChildIdentifier}.
 */
const NODE_SLUG_MAX = 16;

/** Length of the node-id hash carried alongside the truncated readable slug. */
const NODE_HASH_LEN = 8;

/**
 * Build the worktree identifier for one sub-run child. It becomes the branch name
 * (`archon/task-<identifier>`, slugified) and the `isolation_environments.workflow_id`,
 * so it must be UNIQUE per (parent run, workflow node, fan-out index).
 *
 * Uniqueness is load-bearing, not cosmetic: `WorktreeProvider.create()` ADOPTS an
 * existing worktree at the computed path (an INFO `worktree_adopted` line, no error).
 * Two children colliding on an identifier therefore silently share one checkout —
 * the opposite of what `isolation: worktree` asked for — and, when they're in the
 * same DAG layer, land on the same `working_path`, where the sibling path-lock
 * cancels one of them (#2180 Defect A, reproduced in the case the author got right).
 *
 * The node id cannot go in verbatim: the provider truncates the slug at 50 chars, so
 * two long node ids sharing a prefix would collide exactly as before, just less
 * often. Instead the readable part is bounded to {@link NODE_SLUG_MAX} and the FULL
 * node id is carried in a hash suffix, which keeps the branch legible while making
 * the key as fine-grained as the thing it names. Worst case (4-digit fan-out index)
 * is 45 chars, comfortably inside the cap.
 *
 * The result is already slug-shaped, so `isolation_environments.workflow_id` and the
 * branch suffix the provider derives from it are byte-identical — which is what makes
 * an env row findable from a branch name.
 */
export function buildChildIdentifier(
  parentRunId: string,
  nodeId: string,
  childIndex: number
): string {
  const nodeSlug = nodeId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, NODE_SLUG_MAX)
    // Truncation can land mid-separator ('abcdefghijklmno-p' → 'abcdefghijklmno-'),
    // which would leave a '--' the provider's slugify collapses — making the stored
    // workflow_id differ from the branch. Trim it here so the two stay identical.
    .replace(/-+$/, '');
  const nodeHash = createHash('sha256').update(nodeId).digest('hex').slice(0, NODE_HASH_LEN);
  // Empty segments are dropped rather than joined. A node id can slugify to nothing
  // — `###`, `___`, `日本語`, `🚀` are all valid ids today (`id: z.string()` carries no
  // pattern) — and an empty readable part would leave a doubled separator that the
  // provider's own slugify collapses, so the stored workflow_id would no longer be
  // byte-identical to the branch derived from it. The hash carries the full node id,
  // so dropping the readable part costs legibility, never uniqueness.
  // The 8-char parent prefix stays unique per parent run without eating the budget.
  return [parentRunId.slice(0, 8), nodeSlug, nodeHash, 'child', String(childIndex)]
    .filter(segment => segment !== '')
    .join('-');
}

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflows.child-isolation');
  return cachedLog;
}

/**
 * Build the {@link ChildIsolationResolver} for a run in `codebase`, or `undefined` for
 * a folder project: it cannot make worktrees, so no resolver is injected and the engine
 * fails a `workflow:` node requesting `isolation: 'worktree'` fast.
 *
 * `resolve()` creates a per-child worktree + branch
 * (`archon/task-<parent>-<node>-<hash>-child-<i>`) and registers it. It throws (surfaced
 * by the engine as a failed node outcome) when the worktree cannot be created — never
 * returns the shared checkout as a fallback.
 */
export function createCodebaseChildResolver(
  isolation: IIsolationStore,
  codebase: Pick<Codebase, 'id' | 'name' | 'default_cwd' | 'kind'>,
  surface: {
    /**
     * Base-branch fallback for new child worktrees (the codebase's `default_branch`).
     *
     * This is the ONLY base input a child worktree gets. The per-dispatch `--base` /
     * `--from` overrides (#2203) are deliberately NOT threaded here: unlike the
     * top-level CLI path, `resolve()` passes no `baseOverride`/task branch selection to the
     * provider, so a child is cut from `origin/<worktree.baseBranch ?? this ?? auto>`
     * of the canonical repo no matter what the parent run was dispatched with. Which
     * also means a child sees neither the parent's uncommitted work nor its commits —
     * what reaches a child travels through `input:` and `$ARTIFACTS_DIR`, not the tree.
     * Threading `--base` down is a real design question (stacked-from-parent vs
     * cut-from-base) rather than an oversight; documented in the authoring guide.
     */
    baseBranch: string | undefined;
    /** Platform recorded on the `isolation_environments` row (e.g. `'cli'`, `'web'`). */
    createdByPlatform: string;
    /** Archon user id recorded as the environment creator (attribution). */
    createdByUserId: string | undefined;
  },
  deps: WorktreeSetupDeps
): ChildIsolationResolver | undefined {
  if (codebase.kind === 'folder') return undefined;

  // Configure here, not in the caller: a `--no-worktree` parent skips the CLI and
  // orchestrator configuration, and an unconfigured provider silently ignores the
  // repo's `worktree:` block (copyFiles, postCreate) for the child's worktree.
  configureWorktreeIsolation();

  return {
    async resolve(req: ChildIsolationRequest): Promise<ChildIsolationResult> {
      const childIndex = req.childIndex ?? 0;

      // Guard: the engine passes the parent run's codebase_id; it must match the
      // codebase this resolver was built for. A mismatch means the resolver was
      // wired to the wrong codebase (worktrees would land in the wrong repo) —
      // fail loud rather than create a checkout in the wrong project.
      if (req.codebaseId !== undefined && req.codebaseId !== codebase.id) {
        throw new Error(
          `Child-isolation resolver bound to codebase '${codebase.id}' but the sub-run ` +
            `carries codebase '${req.codebaseId}'.`
        );
      }

      // Unique per (parent run, node, fan-out index) — the node id is what keeps two
      // `isolation: worktree` nodes in one parent from adopting each other's worktree.
      const identifier = buildChildIdentifier(req.parentRun.id, req.nodeId, childIndex);

      try {
        const created = await createRegisteredWorktree(isolation, {
          request: {
            workflowType: 'task',
            identifier,
            baseBranch: surface.baseBranch ? git.toBranchName(surface.baseBranch) : undefined,
            codebaseId: codebase.id,
            codebaseName: codebase.name,
            canonicalRepoPath: git.toRepoPath(codebase.default_cwd),
            description: `sub-run child ${String(childIndex)} (node ${req.nodeId})`,
          },
          setupExecutor: createRunWorktreeSetupExecutor(deps, req.parentRun, req.setupEnvironment, {
            parentNodeId: req.nodeId,
            childIndex,
          }),
          createdByPlatform: surface.createdByPlatform,
          ...(surface.createdByUserId ? { createdByUserId: surface.createdByUserId } : {}),
          metadata: { parent_run_id: req.parentRun.id, child_index: childIndex },
        });
        const { env } = created;

        // A spawn can fail before its run row is written. Reusing that slot
        // recovers it, but adoption revokes the previous creation proof.
        if (env.metadata.adopted) {
          getLog().warn(
            {
              parentRunId: req.parentRun.id,
              nodeId: req.nodeId,
              childIndex,
              branch: env.branchName,
              workingPath: env.workingPath,
            },
            'workflow.child_worktree_adopted'
          );
        }

        getLog().info(
          {
            parentRunId: req.parentRun.id,
            nodeId: req.nodeId,
            childIndex,
            branch: env.branchName,
            envId: created.envId,
            adopted: env.metadata.adopted,
          },
          'workflow.child_worktree_created'
        );

        return {
          cwd: env.workingPath,
          envId: created.envId,
          ...(created.ownedWorktree ? { ownedWorktree: created.ownedWorktree } : {}),
          branchName: env.branchName,
          ...(created.cutFromCommit !== undefined ? { cutFromCommit: created.cutFromCommit } : {}),
        };
      } catch (err) {
        // Paired failure log for the `_created` info line above (CLAUDE.md convention).
        // The executor prepends the sub-run context to the message.
        getLog().error(
          { err, parentRunId: req.parentRun.id, nodeId: req.nodeId, childIndex },
          'workflow.child_worktree_create_failed'
        );
        throw err;
      }
    },
  };
}
