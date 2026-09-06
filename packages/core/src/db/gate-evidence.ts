import { randomUUID } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { z } from 'zod';
import { MANAGED_PROVIDER_CREDENTIAL_RELATIVE_PATHS } from '@archon/workflows/deps';
import { join, extname } from 'node:path';
import * as paths from '@archon/paths';
import type { ApprovalContext, WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import {
  canonicalJson,
  evidenceDigest,
  GATE_EVIDENCE_POLICY,
  type TransactionQuery,
} from './workflow-commands';

const EVIDENCE_DIRECTORY = 'approval-evidence';
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const REVIEW_EXTENSIONS = new Set(['.json', '.md', '.txt', '.diff', '.patch']);
const CREDENTIAL_ROOTS = new Set(
  MANAGED_PROVIDER_CREDENTIAL_RELATIVE_PATHS.map(path => path.split('/')[0])
);

function permittedEvidencePath(value: string): boolean {
  const parts = value.split('/');
  return (
    value.length > 0 &&
    !value.includes('\\') &&
    !value.includes(':') &&
    !value.includes('\0') &&
    parts.every(
      part =>
        part.length > 0 &&
        part !== '.' &&
        part !== '..' &&
        !part.startsWith('.') &&
        !CREDENTIAL_ROOTS.has(part.toLowerCase()) &&
        !part.toLowerCase().endsWith('-home') &&
        !['auth.json', 'credentials.json', 'tokens.json', 'oauth.json'].includes(part.toLowerCase())
    ) &&
    value !== 'manifest.json' &&
    REVIEW_EXTENSIONS.has(extname(value).toLowerCase())
  );
}

/** Inspect every component before opening; never follow an alias into credential storage. */
async function readEvidenceFile(
  root: string,
  relativePath: string,
  limit: number
): Promise<Buffer> {
  const parts = relativePath.split('/');
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const info = await lstat(current);
    if (
      info.isSymbolicLink() ||
      (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())
    ) {
      throw new Error('Approval evidence must contain regular files without symlinks');
    }
  }
  const before = await lstat(current);
  if (before.nlink !== 1 || before.size > limit) {
    throw new Error('Approval evidence must be bounded and cannot use hardlinks');
  }
  const file = await open(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await file.stat();
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.nlink !== 1 ||
      opened.size !== before.size
    ) {
      throw new Error('Approval evidence changed while opening');
    }
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await file.stat();
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error('Approval evidence changed while reading');
    }
    return bytes.subarray(0, length);
  } finally {
    await file.close();
  }
}

/**
 * Only the dedicated review namespace is eligible, never the general artifacts tree.
 * A deterministic workflow producer copies approved review inputs here and writes
 * the manifest last. Manifest selection cannot cross that boundary or opt in to
 * managed credential paths, even through a symlink/hardlink or traversal alias.
 */
async function artifactBytes(artifactsRoot: string): Promise<Record<string, string>> {
  const root = join(artifactsRoot, EVIDENCE_DIRECTORY);
  let info;
  try {
    info = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('Invalid approval evidence directory');
  const raw = await readEvidenceFile(root, 'manifest.json', MAX_MANIFEST_BYTES);
  const manifest = manifestSchema.parse(JSON.parse(raw.toString('utf8')) as unknown);
  if (new Set(manifest.files).size !== manifest.files.length)
    throw new Error('Duplicate approval evidence paths');
  const files: Record<string, string> = {};
  let total = 0;
  for (const name of [...manifest.files].sort()) {
    if (!permittedEvidencePath(name)) throw new Error('Forbidden approval evidence path');
    const bytes = await readEvidenceFile(root, name, MAX_FILE_BYTES);
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) throw new Error('Approval evidence exceeds the total byte limit');
    files[name] = bytes.toString('base64');
  }
  return files;
}

const manifestSchema = z.strictObject({
  version: z.literal(1),
  files: z.array(z.string()).max(256),
});

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
    version: 2,
    artifactPolicy: GATE_EVIDENCE_POLICY,
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
