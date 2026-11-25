/**
 * Host wiring for the attention queue (`@archon/workflows/attention-queue`): the branch
 * lookup it reads from isolation records, and the project a query is scoped to.
 */
import { canonicalizeProjectPath, createLogger } from '@archon/paths';
import { projectKeyForCodebase } from '@archon/paths/archon-paths';
import type { LimitBindingsReader } from '@archon/workflows/start-limit';
import {
  projectRef,
  type AttentionQueueSource,
  type ProjectRef,
} from '@archon/workflows/attention-queue';
import {
  overdueWaitItems,
  type WaitItemStore,
  openAskItems,
  type AskItemStore,
  stoppedItems,
  type StoppedItemStore,
  refusedStartItems,
  type RefusedStartItemStore,
} from '@archon/workflows/queue-items-without-run';
import { stateProjectKeySchema } from '@archon/workflows/state-document-store';
import type { Codebase } from '../schemas/codebase';
import { resolveCodebaseForPath } from '../services/codebase-checkout-resolver';
import { observeRunOwner, observeStartExecutor } from '../services/run-attention-watch';
import type { StartExecutorObserver } from '@archon/workflows/resource-start-store';
import type { IWorkflowStore } from '@archon/workflows/store';
import type { IWorkflowHostStore } from '../workflows/host-store';
import { getTriggersPath, readOnBindings } from '../workflows/run-ended';

// Lazy logger: never at module scope.
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('operations.attention-queue');
  return cachedLog;
}

/**
 * The queue's source on a host, keeping the store's type so a reader that needs more of
 * the store (`readItem`) takes the same source. A run's branch is the newest isolation record for its
 * checkout path; a paused run holds that path, so no later checkout can have taken it.
 * The items no run holds are the open asks completed runs left, their overdue waits and the
 * items they stopped. An item holder's owner is
 * observed by the rule `workflow wait` uses (`observeRunOwner`), so the queue lists a
 * holder whose owner is gone and an item read says so; observing never changes the run.
 * A pending admitted start's executor is observed by `observeStartExecutor`, so an item
 * read tells a start that is starting from one nobody runs.
 */
export function attentionQueueSource<
  Store extends AttentionQueueSource['store'] &
    AskItemStore &
    WaitItemStore &
    StoppedItemStore &
    RefusedStartItemStore &
    Pick<IWorkflowStore, 'listWaitedItemHolders'>,
>(
  store: Store,
  isolation: Pick<IWorkflowHostStore['isolation'], 'findLatestByCodebaseAndWorkingPath'>
): AttentionQueueSource & {
  store: Store;
  startExecutor: StartExecutorObserver;
  limitBindings: LimitBindingsReader;
} {
  return {
    store,
    itemsWithoutRun: async () => [
      ...(await openAskItems(store)),
      ...(await overdueWaitItems(store)),
      ...(await stoppedItems(store)),
      ...(await refusedStartItems(store)),
    ],
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
    ownerLost: {
      holders: () => store.listWaitedItemHolders(),
      observe: run => observeRunOwner(store, run),
    },
    startExecutor: { observe: run => observeStartExecutor(store, run) },
    // A broken trigger file already fails the run end that reads it; an item read reports
    // the limits without their bindings instead of failing.
    limitBindings: async () => {
      try {
        return (await readOnBindings(getTriggersPath())).flatMap(file =>
          file.binding.limit === undefined
            ? []
            : [
                {
                  limit: file.binding.limit.name,
                  bindingId: file.binding.bindingId,
                  workflow: file.binding.launch.workflowName,
                  runEnded:
                    'runEnded' in file
                      ? { workflowName: file.runEnded.workflowName, outcome: file.runEnded.outcome }
                      : null,
                },
              ]
        );
      } catch (error) {
        getLog().warn({ err: error }, 'item_read.limit_bindings_unreadable');
        return null;
      }
    },
  };
}

/** What the attention watch takes from a host's queue source: everything but the store. */
export function watchSource(
  source: AttentionQueueSource
): Pick<AttentionQueueSource, 'branchOf' | 'itemsWithoutRun'> {
  return {
    branchOf: source.branchOf,
    ...(source.itemsWithoutRun === undefined ? {} : { itemsWithoutRun: source.itemsWithoutRun }),
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
