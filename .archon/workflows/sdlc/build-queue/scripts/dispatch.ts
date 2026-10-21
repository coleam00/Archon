import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseQualifiedPr, record, type QualifiedPr } from '../../.shared/forge.ts';
import { artifactsDir, emit, nullableJson, refuse, text, trimmed } from '../../.shared/io.ts';
import { launchDetached } from '../../.shared/launch.ts';
import { runDetail } from '../../.shared/state.ts';
import { read, workItemName, type WorkItem } from '../../.shared/workitem.ts';

function readItem(item: QualifiedPr): WorkItem {
  const stored = read(workItemName(item.number));
  if (stored === undefined) throw new Error('the selected work item no longer exists');
  return stored.doc;
}

function dispatchWorker(item: QualifiedPr, runId: string, branch: string, roundLimit: string): { worker: string; receipt: string } {
  const dir = join(artifactsDir(), 'build');
  mkdirSync(dir, { recursive: true });
  const receipt = join(dir, 'dispatch.json');
  const marker = join(dir, 'dispatch-started.json');
  let worker: string | undefined;
  if (existsSync(receipt)) {
    const saved = record(JSON.parse(readFileSync(receipt, 'utf8')));
    if (typeof saved?.run_id !== 'string') throw new Error(`invalid launch receipt ${receipt}`);
    worker = saved.run_id;
  } else {
    // A missing receipt cannot prove that the detached CLI never started its child.
    if (existsSync(marker)) {
      const doc = readItem(item);
      worker = doc.links.runs.find(id => {
        const detail = runDetail(id);
        return detail?.workflow_name === 'archon-build-round' && record(record(detail.metadata)?.inputs)?.pickup_run === runId;
      });
      if (worker === undefined)
        throw new Error(`uncertain worker launch for issue ${String(item.number)}; evidence: ${marker}. Inspect archon workflow runs --json, resume the existing worker, or explicitly abandon pickup ${runId} after verifying no worker exists. The claim is retained.`);
    } else {
      if (readItem(item).claim?.run_id !== runId) throw new Error('this pickup no longer holds the selected item; nothing was launched');
      writeFileSync(marker, JSON.stringify({ pickup_run: runId, item, branch }), { flag: 'wx' });
      worker = launchDetached('archon-build-round', {
        repo_host: item.repo.host, repo_path: item.repo.path, number: String(item.number),
        pickup_run: runId, selected_branch: branch, round_limit: roundLimit,
      }, { configFromRun: runId, branch });
    }
    writeFileSync(receipt, JSON.stringify({ run_id: worker }));
  }
  return { worker, receipt };
}

async function main(): Promise<void> {
  if (trimmed(process.env.INPUTS_PATH) !== 'route') {
    const settled = record(nullableJson(process.env.INPUTS_SETTLED));
    emit({ run_id: null, summary: settled?.summary ?? 'No build item selected.' });
    return;
  }
  const item = parseQualifiedPr(process.env.INPUTS_ITEM);
  const runId = text(process.env.WORKFLOW_ID);
  const branch = trimmed(process.env.INPUTS_BRANCH);
  if (runId === '' || branch === '') throw new Error('run id and selected branch are required');
  const { worker, receipt } = dispatchWorker(item, runId, branch, trimmed(process.env.INPUTS_ROUND_LIMIT));
  const deadline = Date.now() + 30_000;
  while (!readItem(item).links.runs.includes(worker)) {
    if (Date.now() >= deadline)
      throw new Error(`worker ${worker} has not acknowledged admission. Resume that worker; inspect ${receipt}. Its process and the item's claim are retained.`);
    await Bun.sleep(100);
  }
  emit({ run_id: worker, summary: `Issue ${String(item.number)}: build round ${worker} admitted on ${branch}.` });
}

try {
  await main();
} catch (error) {
  refuse(`build-queue dispatch: ${error instanceof Error ? error.message : String(error)}. Inspect the build/dispatch launch evidence before retrying; no claim was released.`);
}
