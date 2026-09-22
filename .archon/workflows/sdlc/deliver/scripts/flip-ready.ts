import {
  ForgeOperationError,
  invokeForge,
  parsePrRecord,
  readChecks,
  preferredChecks,
  record,
} from '../../.shared/forge.ts';
import { emit, note, refuse } from '../../.shared/io.ts';

function main(): void {
  try {
    const initial = parsePrRecord(JSON.parse(process.env.INPUTS_PR ?? ''));
    const viewed = invokeForge('pr.view', { selector: { kind: 'number', ref: initial } });
    const current = parsePrRecord(record(viewed)?.pr);

    if (current.state === 'merged') {
      note('flip-ready: the PR was already merged, so no flip was needed.');
      emit({ pr_url: current.url });
      return;
    }
    if (current.state === 'closed') {
      refuse('flip-ready: the PR is closed without a merge.');
      return;
    }

    const observation = readChecks(JSON.stringify(current));
    const checks = preferredChecks(observation);
    if (checks.summary.state !== 'green' && checks.summary.state !== 'none') {
      throw new Error(`refusing at ${observation.revision} with ${checks.summary.state} checks`);
    }

    try {
      const value = invokeForge('pr.ready', { ref: current });
      const observed = parsePrRecord(record(value)?.pr);
      if (observed.is_draft) throw new Error('PR still reports draft after the ready operation');
      emit({ pr_url: observed.url });
    } catch (error) {
      const mutation = error instanceof ForgeOperationError ? error.mutation : undefined;
      const observed = mutation ? record(mutation.observed) : undefined;
      if (mutation?.outcome === 'refused' && observed) {
        const reconciled = parsePrRecord(observed);
        if (reconciled.state === 'merged') {
          note('flip-ready: the PR merged before the ready operation completed.');
          emit({ pr_url: reconciled.url });
          return;
        }
      }
      throw error;
    }
  } catch (error) {
    refuse(`flip-ready: ${error instanceof Error ? error.message : String(error)}`);
  }
}

main();
