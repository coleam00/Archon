/**
 * Child-isolation resolver factory (#2121 slice 2, PR-A).
 *
 * Constructs the {@link ChildIsolationResolver} port the workflow engine calls once
 * per `workflow:` child whose node declares `isolation: 'worktree'`. Lives in
 * `@archon/core` — the layer that already depends on BOTH `@archon/workflows` (the
 * port TYPE) and `@archon/isolation` (`WorktreeProvider`) — so the port stays
 * isolation-free (`@archon/workflows` never imports `@archon/isolation`) AND the
 * five injection sites (CLI + orchestrator dispatch/resume/background) share one
 * implementation instead of duplicating the worktree-create wiring.
 *
 * Mirrors the top-level CLI worktree creation (`packages/cli/src/commands/workflow.ts`):
 * `WorktreeProvider.create({ workflowType: 'task', … })` for a fresh
 * `archon/task-<parent>-<node>-<hash>-child-<i>` branch, then registers the
 * `isolation_environments` row so standard `isolation list`/`cleanup`/`complete`
 * hygiene applies to child worktrees.
 */

import type {
  ChildIsolationResolver,
  ChildIsolationRequest,
  ChildIsolationResult,
} from '@archon/workflows/executor';
import { createHash } from 'node:crypto';
import {
  getIsolationProvider,
  configureIsolation,
  classifyIsolationError,
} from '@archon/isolation';
import * as git from '@archon/git';
import { createLogger } from '@archon/paths';
import { loadRepoConfig } from '../config/config-loader';
import * as isolationDb from '../db/isolation-environments';

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

/** Codebase-scoped context captured when the caller builds the resolver. */
export interface ChildWorktreeResolverConfig {
  /** Codebase the child worktrees belong to (attribution + worktree pathing). */
  codebaseId: string;
  /** "owner/repo" name — lets the provider resolve the project-scoped worktree path. */
  codebaseName: string;
  /** Canonical checkout path of the main repo (the codebase's `default_cwd`). */
  canonicalRepoPath: string;
  /**
   * Base-branch fallback for new child worktrees (the codebase's `default_branch`).
   *
   * This is the ONLY base input a child worktree gets. The per-dispatch `--base` /
   * `--from` overrides (#2203) are deliberately NOT threaded here: unlike the
   * top-level CLI path, `resolve()` passes no `baseOverride`/`fromBranch` to the
   * provider, so a child is cut from `origin/<worktree.baseBranch ?? this ?? auto>`
   * of the canonical repo no matter what the parent run was dispatched with. Which
   * also means a child sees neither the parent's uncommitted work nor its commits —
   * what reaches a child travels through `input:` and `$ARTIFACTS_DIR`, not the tree.
   * Threading `--base` down is a real design question (stacked-from-parent vs
   * cut-from-base) rather than an oversight; documented in the authoring guide.
   */
  baseBranch?: string;
  /** Platform recorded on the `isolation_environments` row (e.g. `'cli'`, `'web'`). */
  createdByPlatform: string;
  /** Archon user id recorded as the environment creator (attribution). */
  createdByUserId?: string;
}

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflows.child-isolation');
  return cachedLog;
}

/**
 * Build a {@link ChildIsolationResolver} bound to one codebase. `resolve()` creates
 * a per-child worktree + branch (`archon/task-<parent>-<node>-<hash>-child-<i>`) and registers it.
 * Throws (surfaced by the engine as a failed node outcome) when the worktree cannot
 * be created — never returns the shared checkout as a fallback.
 */
export function createChildWorktreeResolver(
  config: ChildWorktreeResolverConfig
): ChildIsolationResolver {
  // Configure the isolation provider HERE rather than relying on the caller.
  //
  // `configureIsolation` is what gives `WorktreeProvider` the repo-config loader;
  // without it the factory falls back to `() => Promise.resolve(null)` and the
  // repo's ENTIRE `worktree:` block is silently ignored — `baseBranch`, `path`,
  // `remote`, and `copyFiles` (the sting: files the repo seeds into worktrees,
  // e.g. `.env`, simply never arrive, and the child's build fails confusingly).
  //
  // Both existing callers only configure it on paths that create a TOP-LEVEL
  // worktree: the CLI inside `else if (wantsIsolation && codebase)`, the
  // orchestrator via `getResolver()`. A `--no-worktree` parent — the shape the
  // authoring guide explicitly endorses, "a parent started with --no-worktree can
  // still hand an isolated child its own worktree" — skips both and would create
  // the child's worktree unconfigured. Binding it to the resolver instead means
  // every construction site is covered, including ones added later.
  //
  // Idempotent and cheap: it swaps the loader and drops the provider singleton,
  // which is rebuilt lazily. Re-running it after the CLI/orchestrator already
  // configured it is a no-op in effect — all three loaders are the same function.
  configureIsolation(async (repoPath: string) => {
    const repoConfig = await loadRepoConfig(repoPath);
    return repoConfig?.worktree ?? null;
  });

  return {
    async resolve(req: ChildIsolationRequest): Promise<ChildIsolationResult> {
      const childIndex = req.childIndex ?? 0;

      // Guard: the engine passes the parent run's codebase_id; it must match the
      // codebase this resolver was built for. A mismatch means the resolver was
      // wired to the wrong codebase (worktrees would land in the wrong repo) —
      // fail loud rather than create a checkout in the wrong project.
      if (req.codebaseId !== undefined && req.codebaseId !== config.codebaseId) {
        throw new Error(
          `Child-isolation resolver bound to codebase '${config.codebaseId}' but the sub-run ` +
            `carries codebase '${req.codebaseId}'.`
        );
      }

      // Unique per (parent run, node, fan-out index) — the node id is what keeps two
      // `isolation: worktree` nodes in one parent from adopting each other's worktree.
      const identifier = buildChildIdentifier(req.parentRun.id, req.nodeId, childIndex);

      try {
        const provider = getIsolationProvider();
        const isolatedEnv = await provider.create({
          workflowType: 'task',
          identifier,
          baseBranch: config.baseBranch ? git.toBranchName(config.baseBranch) : undefined,
          codebaseId: config.codebaseId,
          codebaseName: config.codebaseName,
          canonicalRepoPath: git.toRepoPath(config.canonicalRepoPath),
          description: `sub-run child ${String(childIndex)} (node ${req.nodeId})`,
        });

        // Register the env so `isolation list`/`cleanup`/`complete <branch>` see it.
        const envRecord = await isolationDb.create({
          codebase_id: config.codebaseId,
          workflow_type: 'task',
          workflow_id: identifier,
          provider: 'worktree',
          working_path: isolatedEnv.workingPath,
          branch_name: isolatedEnv.branchName,
          created_by_platform: config.createdByPlatform,
          ...(config.createdByUserId ? { created_by_user_id: config.createdByUserId } : {}),
          // `adopted` records whether this row describes a worktree Archon created or
          // one that was already on disk — see the note below on why re-use is allowed.
          // Durable on purpose: a log line is gone by the time anyone asks why two runs
          // touched one checkout.
          metadata: {
            parent_run_id: req.parentRun.id,
            child_index: childIndex,
            adopted: isolatedEnv.metadata.adopted,
          },
        });

        // `WorktreeProvider.create()` ADOPTS a worktree already sitting at the computed
        // path instead of failing. That is what made the pre-fix identifier collision
        // silent, so it must never be quiet on this path again.
        //
        // Adoption stays ALLOWED rather than rejected. The reason is NOT that resume
        // can't reach this code — it can. The parent's re-entry finds its child by
        // (parent_run_id, parent_node_id); when that row was never written, or was
        // deleted, the node takes the fresh-spawn path and calls `resolve()` again.
        // Two properties are what make that safe, and both are load-bearing:
        //
        //  1. `buildChildIdentifier` is deterministic in (parentRunId, nodeId,
        //     childIndex), so re-spawning the SAME slot recomputes the SAME path.
        //     Nothing else computes this identifier, so whatever is sitting there is
        //     this slot's own from an earlier attempt — never a sibling's live checkout.
        //  2. `isolationDb.create()` is an UPSERT (`ON CONFLICT (codebase_id,
        //     workflow_type, workflow_id) WHERE status = 'active' DO UPDATE`, see
        //     `db/isolation-environments.ts`), so the re-spawn refreshes the existing
        //     env row rather than failing on the unique index. "Simplifying" that to a
        //     plain INSERT breaks exactly the recovery this comment is describing.
        //
        // Rejecting adoption would turn a spawn that died between `provider.create()`
        // and `createWorkflowRun` from "recovers on the next resume" into "wedged
        // permanently". If this WARN ever fires for a SIBLING's checkout, the
        // identifier has regressed and this line is the evidence.
        if (isolatedEnv.metadata.adopted) {
          getLog().warn(
            {
              parentRunId: req.parentRun.id,
              nodeId: req.nodeId,
              childIndex,
              branch: isolatedEnv.branchName,
              workingPath: isolatedEnv.workingPath,
            },
            'workflow.child_worktree_adopted'
          );
        }

        getLog().info(
          {
            parentRunId: req.parentRun.id,
            nodeId: req.nodeId,
            childIndex,
            branch: isolatedEnv.branchName,
            envId: envRecord.id,
            adopted: isolatedEnv.metadata.adopted,
          },
          'workflow.child_worktree_created'
        );

        return {
          cwd: isolatedEnv.workingPath,
          envId: envRecord.id,
          branchName: isolatedEnv.branchName,
        };
      } catch (err) {
        const error = err as Error;
        // Paired failure log for the `_created` info line above (CLAUDE.md convention).
        getLog().error(
          { err: error, parentRunId: req.parentRun.id, nodeId: req.nodeId, childIndex },
          'workflow.child_worktree_create_failed'
        );
        // Map raw git/disk/permission stderr to an actionable message (the repo
        // pattern the top-level worktree path uses); the executor prepends the
        // sub-run context. classifyIsolationError falls through to the raw message
        // for anything it doesn't recognize, so nothing is swallowed.
        throw new Error(classifyIsolationError(error));
      }
    },
  };
}
