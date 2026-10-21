import { withBuild } from '../../.shared/build.ts';
import { parseQualifiedPr } from '../../.shared/forge.ts';
import { emit, refuse, text, trimmed } from '../../.shared/io.ts';
import { idleSummary, stuckItems } from '../../.shared/stuck.ts';
import { updateClaimed } from '../../.shared/workitem.ts';

function main(): void {
  const path = trimmed(process.env.INPUTS_PATH);
  const runId = text(process.env.WORKFLOW_ID);
  let summary: string;
  if (path === 'idle') {
    summary = idleSummary('No item waits for the build queue.', stuckItems(runId));
  } else {
    if (path !== 'closed') throw new Error(`cannot settle ${path} without a build round`);
    const item = parseQualifiedPr(process.env.INPUTS_ITEM);
    const at = new Date().toISOString();
    const reason = 'the issue is closed';
    updateClaimed(item, runId, doc => withBuild(doc, {
      at, run_id: runId, round: null, entry: { at, run_id: runId, decision: 'parked', reason, links: [] },
      status: 'parked', brief: '', release: true,
    }));
    summary = `Issue ${String(item.number)}: parked. ${reason}`;
  }
  emit({ summary });
}

try {
  main();
} catch (error) {
  refuse(`build-queue settle: ${error instanceof Error ? error.message : String(error)}`);
}
