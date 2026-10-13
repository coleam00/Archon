import { startRunLiveOwner } from '@archon/core/services/run-live-owner';
import { createRunWorktreeSetupExecutor } from '@archon/core/workflows/worktree-setup';

const [runId, root, background] = process.argv.slice(2);
if (!runId || !root) throw new Error('Usage: setup-run-owner.ts <run-id> <root> <background>');

await startRunLiveOwner(runId, { detachedProcessPid: process.pid });
const descendant = `echo $$ > descendant.pid; touch ready; while [ ! -f go ]; do sleep 0.01; done; touch leaked`;
const command =
  background === 'true' ? `bash -c '${descendant}' & wait` : `true; bash -c '${descendant}'; true`;
await createRunWorktreeSetupExecutor(
  { store: { getCodebase: async () => null, persistWorkflowEvent: async () => undefined } },
  { id: runId, user_id: null },
  {}
)({
  workingPath: root,
  canonicalRepoPath: root,
  codebaseId: 'fixture',
  commands: [command],
  timeout: 60000,
});
