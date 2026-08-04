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
import { getIsolationProvider, classifyIsolationError } from '@archon/isolation';
import * as git from '@archon/git';
import { createLogger } from '@archon/paths';
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
  // 8-char parent prefix stays unique per parent run without eating the budget.
  return `${parentRunId.slice(0, 8)}-${nodeSlug}-${nodeHash}-child-${String(childIndex)}`;
}

/** Codebase-scoped context captured when the caller builds the resolver. */
export interface ChildWorktreeResolverConfig {
  /** Codebase the child worktrees belong to (attribution + worktree pathing). */
  codebaseId: string;
  /** "owner/repo" name — lets the provider resolve the project-scoped worktree path. */
  codebaseName: string;
  /** Canonical checkout path of the main repo (the codebase's `default_cwd`). */
  canonicalRepoPath: string;
  /** Base-branch fallback for new child worktrees (the codebase's `default_branch`). */
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
        // Adoption stays allowed rather than rejected, because with a per-(parent, node,
        // index) identifier the only worktree that can be there is THIS child slot's own
        // from an earlier attempt — a spawn that created the worktree and then failed
        // before its run row was written leaves exactly that, and re-using it is how the
        // parent's resume recovers. Rejecting would wedge that resume permanently.
        // A sibling's checkout is no longer reachable here; if this ever fires for one,
        // the identifier has regressed and this line is the evidence.
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
