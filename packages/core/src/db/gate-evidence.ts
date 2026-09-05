import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as paths from '@archon/paths';
import type { ApprovalContext, WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { canonicalJson, evidenceDigest, type TransactionQuery } from './workflow-commands';

/** Store original bytes, not just mutable file paths supplied to the reviewer. */
async function artifactBytes(root: string, relative = ''): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  let entries;
  try {
    entries = await readdir(join(root, relative), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && relative === '') return files;
    throw error;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Cannot seal symlink artifact: ${name}`);
    if (entry.isDirectory()) Object.assign(files, await artifactBytes(root, name));
    else if (entry.isFile()) files[name] = (await readFile(join(root, name))).toString('base64');
    else throw new Error(`Cannot seal non-file artifact: ${name}`);
  }
  return files;
}

export async function sealGateEvidence(
  query: TransactionQuery,
  run: WorkflowRun,
  approval: ApprovalContext
): Promise<ApprovalContext> {
  const occurrenceId = randomUUID();
  const events = await query<{
    id: string;
    event_type: string;
    step_name: string | null;
    data: unknown;
  }>(
    `SELECT id, event_type, step_name, data FROM remote_agent_workflow_events
      WHERE workflow_run_id = $1 ORDER BY event_order`,
    [run.id]
  );
  const originalApproval = { ...approval };
  delete originalApproval.occurrenceId;
  delete originalApproval.evidenceDigest;
  const evidence = {
    version: 1,
    runId: run.id,
    occurrenceId,
    approval: originalApproval,
    workflowName: run.workflow_name,
    workingPath: run.working_path,
    metadata: run.metadata,
    events: events.rows.map(event => ({
      ...event,
      data: typeof event.data === 'string' ? (JSON.parse(event.data) as unknown) : event.data,
    })),
    artifacts: run.output_root
      ? await artifactBytes(paths.getRunArtifactsDirForRoot(run.output_root, run.id))
      : {},
  };
  const digest = evidenceDigest(evidence);
  await query(
    `INSERT INTO remote_agent_gate_occurrences (occurrence_id, run_id, evidence_digest, evidence)
    VALUES ($1, $2, $3, $4)`,
    [occurrenceId, run.id, digest, canonicalJson(evidence)]
  );
  return { ...originalApproval, occurrenceId, evidenceDigest: digest };
}
