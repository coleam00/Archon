/**
 * Workflow management commands — get, create, update, delete, cancel, runs,
 * inspect, artifacts. Kept separate from workflow.ts (run/list/status/etc.) to
 * keep each module focused.
 *
 * Reads (get/runs/inspect/artifacts) hit the filesystem / DB directly and work
 * without a server. Mutations (create/update/delete/cancel) go through the
 * REST API so they inherit route-handler validation.
 */
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, basename, normalize, sep } from 'node:path';
import { getArchonHome, getRunArtifactsPath } from '@archon/paths';
import { loadConfig } from '@archon/core';
import * as codebaseDb from '@archon/core/db/codebases';
import * as workflowDb from '@archon/core/db/workflows';
import * as workflowEventsDb from '@archon/core/db/workflow-events';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import type { WorkflowRunStatus } from '@archon/workflows/schemas/workflow-run';
import { createApiClient } from '../api-client';
import { confirmOrAbort } from '../prompt';
import { formatAge, formatDuration, buildNodeSummaries } from './workflow';

const VALID_RUN_STATUSES = [
  'running',
  'completed',
  'failed',
  'cancelled',
  'pending',
  'paused',
] as const;

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

/** Recursively search a directory for a workflow YAML whose `name` matches. */
async function scanForWorkflowFile(dir: string, name: string): Promise<string | null> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await scanForWorkflowFile(full, name);
      if (nested) return nested;
    } else if (entry.isFile() && /\.ya?ml$/.test(entry.name)) {
      let content: string;
      try {
        content = await readFile(full, 'utf-8');
      } catch {
        continue;
      }
      try {
        const parsed = Bun.YAML.parse(content) as { name?: unknown } | null;
        if (parsed && typeof parsed === 'object' && parsed.name === name) return content;
      } catch {
        continue;
      }
    }
  }
  return null;
}

/** Locate the on-disk source YAML for a workflow (project then global scope). */
async function findWorkflowSourceFile(cwd: string, name: string): Promise<string | null> {
  for (const dir of [join(cwd, '.archon', 'workflows'), join(getArchonHome(), 'workflows')]) {
    const found = await scanForWorkflowFile(dir, name);
    if (found) return found;
  }
  return null;
}

export async function workflowGetCommand(
  name: string,
  cwd: string,
  opts: { json?: boolean }
): Promise<void> {
  const { workflows } = await discoverWorkflowsWithConfig(cwd, loadConfig);
  const match =
    workflows.find(w => w.workflow.name === name) ??
    workflows.find(w => w.workflow.name.toLowerCase() === name.toLowerCase());
  if (!match) throw new Error(`Workflow not found: ${name}`);

  if (opts.json) {
    console.log(JSON.stringify(match.workflow, null, 2));
    return;
  }

  const raw = await findWorkflowSourceFile(cwd, match.workflow.name);
  if (raw) {
    console.log(`# source: ${match.source}`);
    console.log(raw);
  } else {
    // Bundled workflows have no on-disk file in binary builds — fall back to JSON.
    process.stderr.write(
      `Raw YAML unavailable for "${match.workflow.name}" (source: ${match.source}); showing parsed JSON.\n`
    );
    console.log(JSON.stringify(match.workflow, null, 2));
  }
}

// ---------------------------------------------------------------------------
// create / update / delete (REST API — server validates before writing)
// ---------------------------------------------------------------------------

async function putWorkflowFromFile(
  name: string,
  file: string,
  cwd: string,
  serverUrl?: string
): Promise<void> {
  const content = await readFile(file, 'utf-8');
  const definition = Bun.YAML.parse(content);
  if (!definition || typeof definition !== 'object') {
    throw new Error(`File "${file}" does not contain a YAML object.`);
  }
  const api = createApiClient(serverUrl);
  await api.put(`/api/workflows/${encodeURIComponent(name)}?cwd=${encodeURIComponent(cwd)}`, {
    definition,
  });
}

export async function workflowCreateCommand(
  file: string,
  cwd: string,
  opts: { name?: string },
  serverUrl?: string
): Promise<void> {
  const name = opts.name ?? basename(file).replace(/\.ya?ml$/, '');
  await putWorkflowFromFile(name, file, cwd, serverUrl);
  console.log(`Created workflow "${name}".`);
}

export async function workflowUpdateCommand(
  name: string,
  file: string,
  cwd: string,
  serverUrl?: string
): Promise<void> {
  await putWorkflowFromFile(name, file, cwd, serverUrl);
  console.log(`Updated workflow "${name}".`);
}

export async function workflowDeleteCommand(
  name: string,
  cwd: string,
  opts: { force?: boolean; source?: string },
  serverUrl?: string
): Promise<void> {
  const confirmed = await confirmOrAbort(`Delete workflow "${name}"?`, opts.force);
  if (!confirmed) {
    console.error('Aborted.');
    return;
  }
  const params = new URLSearchParams({ cwd });
  if (opts.source) params.set('source', opts.source);
  const api = createApiClient(serverUrl);
  await api.del(`/api/workflows/${encodeURIComponent(name)}?${params.toString()}`);
  console.log(`Deleted workflow "${name}".`);
}

export async function workflowCancelCommand(runId: string, serverUrl?: string): Promise<void> {
  const api = createApiClient(serverUrl);
  const result = await api.post<{ success: boolean; message: string }>(
    `/api/workflows/runs/${encodeURIComponent(runId)}/cancel`
  );
  console.log(result.message || `Cancelled run ${runId}.`);
}

// ---------------------------------------------------------------------------
// runs / inspect (DB reads)
// ---------------------------------------------------------------------------

export async function workflowRunsCommand(opts: {
  status?: string;
  limit?: number;
  workflow?: string;
  json?: boolean;
}): Promise<void> {
  if (
    opts.status &&
    !VALID_RUN_STATUSES.includes(opts.status as (typeof VALID_RUN_STATUSES)[number])
  ) {
    throw new Error(`Invalid --status "${opts.status}". Valid: ${VALID_RUN_STATUSES.join(', ')}`);
  }

  const runs = await workflowDb.listWorkflowRuns({
    status: opts.status as WorkflowRunStatus | undefined,
    workflowName: opts.workflow,
    limit: opts.limit ?? 20,
  });

  if (opts.json) {
    console.log(JSON.stringify({ runs }, null, 2));
    return;
  }
  if (runs.length === 0) {
    console.log('No workflow runs found.');
    return;
  }
  for (const run of runs) {
    console.log(`\n${run.id}`);
    console.log(`  Workflow: ${run.workflow_name}`);
    console.log(`  Status:   ${run.status}`);
    console.log(`  Started:  ${formatAge(run.started_at)} ago`);
    if (run.working_path) console.log(`  Path:     ${run.working_path}`);
  }
  console.log(`\nTotal: ${String(runs.length)} run(s)`);
}

export async function workflowInspectCommand(runId: string, json?: boolean): Promise<void> {
  const run = await workflowDb.getWorkflowRun(runId);
  if (!run) throw new Error(`Workflow run not found: ${runId}`);
  const events = await workflowEventsDb.listWorkflowEvents(runId);

  if (json) {
    console.log(JSON.stringify({ run, events }, null, 2));
    return;
  }

  console.log(`Run:       ${run.id}`);
  console.log(`Workflow:  ${run.workflow_name}`);
  console.log(`Status:    ${run.status}`);
  console.log(`Started:   ${formatAge(run.started_at)} ago`);
  if (run.working_path) console.log(`Path:      ${run.working_path}`);
  if (run.user_message) console.log(`Message:   ${run.user_message}`);

  const nodes = buildNodeSummaries(events);
  if (nodes.length > 0) {
    console.log('\nNodes:');
    const iconMap: Record<string, string> = {
      completed: '✓',
      failed: '✗',
      skipped: '-',
      running: '◌',
    };
    for (const node of nodes) {
      const icon = iconMap[node.state] ?? '◌';
      const duration = node.durationMs !== undefined ? ` (${formatDuration(node.durationMs)})` : '';
      console.log(`  ${icon} ${node.nodeId}${duration}`);
      if (node.error !== undefined) console.log(`      Error: ${node.error}`);
    }
  }
  console.log(`\nEvents: ${String(events.length)}`);
}

// ---------------------------------------------------------------------------
// artifacts (filesystem reads)
// ---------------------------------------------------------------------------

interface ArtifactFile {
  path: string;
  size: number;
  modifiedAt: string;
}

/**
 * Resolve a run's on-disk artifact directory, mirroring the server's
 * GET /api/runs/:runId/artifacts resolution (run -> codebase name -> owner/repo)
 * with the same defense-in-depth check that the path stays inside ARCHON_HOME.
 */
async function resolveArtifactDir(runId: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error(`Invalid run id: ${runId}`);
  const run = await workflowDb.getWorkflowRun(runId);
  if (!run) throw new Error(`Workflow run not found: ${runId}`);
  if (!run.codebase_id) throw new Error(`Run ${runId} has no associated codebase.`);

  const codebase = await codebaseDb.getCodebase(run.codebase_id);
  const [owner, repo] = (codebase?.name ?? '').split('/');
  if (!owner || !repo) {
    throw new Error(
      `Codebase for run ${runId} is not in owner/repo form; cannot locate artifacts.`
    );
  }

  const dir = getRunArtifactsPath(owner, repo, runId);
  const home = getArchonHome();
  const normalized = normalize(dir);
  if (!normalized.startsWith(normalize(home) + sep) && normalized !== normalize(home)) {
    throw new Error('Resolved artifact path escapes Archon home.');
  }
  return dir;
}

async function walkArtifacts(dir: string): Promise<ArtifactFile[]> {
  const out: ArtifactFile[] = [];
  async function walk(current: string, rel: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // workflow-internal scratch
      const child = join(current, entry.name);
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(child, childRel);
      } else if (entry.isFile()) {
        const s = await stat(child);
        out.push({ path: childRel, size: s.size, modifiedAt: s.mtime.toISOString() });
      }
    }
  }
  await walk(dir, '');
  return out;
}

export async function workflowArtifactsListCommand(runId: string, json?: boolean): Promise<void> {
  const dir = await resolveArtifactDir(runId);
  const files = await walkArtifacts(dir);

  if (json) {
    console.log(JSON.stringify({ files }, null, 2));
    return;
  }
  if (files.length === 0) {
    console.log('No artifacts found for this run.');
    return;
  }
  for (const f of files) console.log(`  ${f.path}  (${String(f.size)} bytes)`);
  console.log(`\nTotal: ${String(files.length)} file(s)`);
}

export async function workflowArtifactsGetCommand(
  runId: string,
  relPath: string,
  opts: { output?: string }
): Promise<void> {
  if (relPath.includes('..')) throw new Error('Path traversal ("..") is not allowed.');
  const dir = await resolveArtifactDir(runId);
  const filePath = join(dir, relPath);
  if (!normalize(filePath).startsWith(normalize(dir) + sep)) {
    throw new Error('Resolved path escapes the run artifact directory.');
  }

  let content: Buffer;
  try {
    content = await readFile(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Artifact not found: ${relPath}`);
    }
    throw err;
  }

  if (opts.output) {
    await writeFile(opts.output, content);
    process.stderr.write(`Wrote ${relPath} to ${opts.output}\n`);
  } else {
    process.stdout.write(content);
  }
}
