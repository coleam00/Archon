/**
 * Host wiring for the attention queue (`@archon/workflows/attention-queue`): the branch
 * lookup it reads from isolation records, and the project a query is scoped to.
 */
import { canonicalizeProjectPath } from '@archon/paths';
import { projectKeyForCodebase } from '@archon/paths/archon-paths';
import {
  projectRef,
  type AttentionQueueSource,
  type ProjectRef,
} from '@archon/workflows/attention-queue';
import { stateProjectKeySchema } from '@archon/workflows/state-document-store';
import type { Codebase } from '../schemas/codebase';
import { resolveCodebaseForPath } from '../services/codebase-checkout-resolver';
import type { IWorkflowHostStore } from '../workflows/host-store';

/**
 * The queue's source on a host. A run's branch is the newest isolation record for its
 * checkout path; a paused run holds that path, so no later checkout can have taken it.
 */
export function attentionQueueSource(
  store: AttentionQueueSource['store'],
  isolation: Pick<IWorkflowHostStore['isolation'], 'findLatestByCodebaseAndWorkingPath'>
): AttentionQueueSource {
  return {
    store,
    branchOf: async run =>
      run.codebase_id === null || run.working_path === null
        ? null
        : ((
            await isolation.findLatestByCodebaseAndWorkingPath(
              run.codebase_id,
              run.working_path,
              new Date()
            )
          )?.branch_name ?? null),
  };
}

/** The project a codebase row names, keyed the way `archon state` keys it. */
export function projectRefForCodebase(codebase: Codebase): ProjectRef {
  return projectRef(projectKeyForCodebase(codebase, codebase.default_cwd), codebase);
}

/**
 * Resolve `--project <id|name|key>`: a registered codebase by id, then by name, then a
 * project key with no codebase row, which is how an unregistered directory's project
 * is named. A name two codebases share is refused rather than guessed.
 */
export async function resolveAttentionProject(
  codebases: Pick<IWorkflowHostStore['codebases'], 'listCodebases'>,
  spec: string
): Promise<ProjectRef> {
  const all = await codebases.listCodebases();
  const byId = all.find(codebase => codebase.id === spec);
  if (byId) return projectRefForCodebase(byId);
  const byName = all.filter(codebase => codebase.name === spec);
  if (byName.length > 1)
    throw new Error(
      `Project name '${spec}' matches ${String(byName.length)} codebases (${byName
        .map(codebase => codebase.id)
        .join(', ')}). Name one by id.`
    );
  const [named] = byName;
  if (named) return projectRefForCodebase(named);
  if (stateProjectKeySchema.safeParse(spec).success) return projectRef(spec, null);
  throw new Error(
    `No project matches '${spec}'. Pass a codebase id, a codebase name, or a project key.`
  );
}

/**
 * The project a working directory belongs to, as `archon state` resolves it without
 * registering anything: its codebase, or the unregistered directory's project.
 */
export async function attentionProjectForCwd(
  codebases: Pick<
    IWorkflowHostStore['codebases'],
    'findCodebaseByDefaultCwd' | 'findCodebaseByPathPrefix' | 'listCodebaseClaims'
  >,
  cwd: string
): Promise<ProjectRef> {
  const { codebase, repoRoot } = await resolveCodebaseForPath(cwd, codebases);
  if (codebase) return projectRefForCodebase(codebase);
  return projectRef(
    projectKeyForCodebase(null, repoRoot ?? (await canonicalizeProjectPath(cwd))),
    null
  );
}
