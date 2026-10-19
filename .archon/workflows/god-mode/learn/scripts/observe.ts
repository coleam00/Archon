/**
 * Point the learner at the record. This script judges nothing and summarizes nothing
 * the agent should judge: it lists every recent run, completed or failed, with the
 * facts the engine stored and the paths to its transcript and artifacts, then the
 * state documents and open attention items. `reflect` opens what it needs and finds
 * the patterns itself.
 *
 * A digest of counts and failure lines hides the costly classes: rounds that end
 * "continue" for a reason that repeats, runs that complete but waste their round,
 * work that sits ready without merging. Those live in completed runs' outputs and
 * artifacts, so every run gets a pointer, not only the failed ones.
 *
 * Nothing here knows any pack's conventions. Runs are listed by workflow name, inputs
 * are whatever the run was given, and state documents are listed by name whatever
 * prefix a pack chose.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { cli, cliJson, stateGet } from '../../.shared/archon.ts';
import { emit, run } from '../../.shared/io.ts';
import { LESSONS_DOC, type LessonsDoc } from '../../.shared/lessons.ts';
import { assess, TRUST_DOC, type TrustDoc } from '../../.shared/trust.ts';

interface RunRow {
  id?: string;
  workflow_name?: string;
  status?: string;
  outcome?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  last_activity_at?: string | null;
  parent_run_id?: string | null;
  output_root?: string | null;
  metadata?: { inputs?: Record<string, unknown>; total_cost_usd?: number } | null;
}

interface AttentionItem {
  kind?: string;
  runId?: string;
  workflow?: string;
  node?: string;
  labels?: Record<string, string>;
  message?: string;
  pausedAt?: string | null;
}

interface StateListing {
  documents?: { name: string; revision: number; updatedAt?: string; writer?: { runId?: string; nodePath?: string } }[];
}

/** Keys whose counts are worth reporting: one token, as the engine requires. */
const LABEL_KEY = /^[^\s=]+$/;
const RUN_LIMIT = '200';

function items(raw: unknown): AttentionItem[] {
  if (Array.isArray(raw)) return raw as AttentionItem[];
  const wrapped = (raw as { items?: unknown } | null)?.items;
  if (Array.isArray(wrapped)) return wrapped as AttentionItem[];
  throw new Error('workflow attention --json returned neither a list nor { items }');
}

function oneLine(value: string, max: number): string {
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function minutes(from: string | null | undefined, to: string | null | undefined): string {
  if (!from || !to) return '?';
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) ? `${Math.round(ms / 60000)}m` : '?';
}

/**
 * The last thing the run said: its terminal error, or the output of its last script
 * node (agent nodes' content in the transcript is only their command name). It says
 * where to start reading, not what happened.
 */
function lastWord(transcript: string): string {
  if (!existsSync(transcript)) return '';
  const lines = readFileSync(transcript, 'utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    if (!line.includes('"workflow_error"') && !line.includes('"exec_output"')) continue;
    try {
      const event = JSON.parse(line) as { type?: string; step?: string; error?: string; stdout_tail?: unknown };
      if (event.type === 'workflow_error' && event.error) return `error: ${oneLine(event.error, 200)}`;
      if (event.type === 'exec_output' && typeof event.stdout_tail === 'string' && event.stdout_tail.trim() !== '') {
        return `${event.step ?? '?'}: ${oneLine(event.stdout_tail, 200)}`;
      }
    } catch {
      // A partial line at the end of a live transcript is not evidence; skip it.
    }
  }
  return '';
}

function runLine(r: RunRow, full: boolean): string {
  const id = r.id ?? '?';
  const root = r.output_root ?? '';
  const transcript = root ? `${root}/logs/${id}.jsonl` : '';
  const artifacts = root ? `${root}/artifacts/runs/${id}` : '';
  const cost = typeof r.metadata?.total_cost_usd === 'number' ? ` $${r.metadata.total_cost_usd.toFixed(2)}` : '';
  const inputs = r.metadata?.inputs && Object.keys(r.metadata.inputs).length > 0
    ? ` inputs=${oneLine(JSON.stringify(r.metadata.inputs), 120)}`
    : '';
  const parent = r.parent_run_id ? ` parent=${r.parent_run_id}` : '';
  const said = transcript ? lastWord(transcript) : '';
  if (!full) {
    return `- ${id} ${r.workflow_name ?? 'unknown'} ${r.status ?? '?'}${r.outcome ? `/${r.outcome}` : ''} ${r.started_at ?? '?'} ${minutes(r.started_at, r.completed_at ?? r.last_activity_at)}${cost}${inputs}${parent}${said ? ` | ${oneLine(said, 110)}` : ''}`;
  }
  return [
    `- ${id} ${r.workflow_name ?? 'unknown'} ${r.status ?? '?'}${r.outcome ? `/${r.outcome}` : ''}`,
    ` ${r.started_at ?? '?'} ${minutes(r.started_at, r.completed_at ?? r.last_activity_at)}${cost}${inputs}${parent}`,
    said ? `\n  last: ${said}` : '',
    transcript ? `\n  transcript: ${transcript}${existsSync(artifacts) ? `\n  artifacts: ${artifacts}` : ''}` : '',
  ].join('');
}

run('learn observe', () => {
  const runs = (cliJson(['workflow', 'runs', '--json', '--limit', RUN_LIMIT]) as { runs?: RunRow[] }).runs ?? [];

  const open = items(cliJson(['workflow', 'attention', '--json']));
  const keys = [...new Set(open.flatMap((i) => Object.keys(i.labels ?? {})))].filter((k) => LABEL_KEY.test(k)).sort();
  const labelCounts = keys.map((key) => {
    const counts = new Map<string, number>();
    for (const i of open) {
      const value = i.labels?.[key];
      if (value !== undefined) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return `- ${key}: ${[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ${n}`).join(', ')}`;
  });
  const openList = open
    .map((i) => `- ${i.workflow ?? '?'} run ${i.runId ?? '?'} @ ${i.node ?? '?'} since ${i.pausedAt ?? '?'} ${JSON.stringify(i.labels ?? {})}: ${oneLine(i.message ?? '', 160)}`)
    .join('\n');

  const listing = cli(['state', 'list']);
  const documents = listing.code === 0 ? ((JSON.parse(listing.stdout) as StateListing).documents ?? []) : [];
  const byPrefix = new Map<string, number>();
  for (const d of documents) {
    const prefix = d.name.includes('/') ? `${d.name.split('/')[0]}/` : d.name;
    byPrefix.set(prefix, (byPrefix.get(prefix) ?? 0) + 1);
  }
  const recentDocs = [...documents]
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
    .slice(0, 40)
    .map((d) => `- ${d.name} r${d.revision} ${d.updatedAt ?? '?'}${d.writer?.runId ? ` by run ${d.writer.runId} @ ${d.writer.nodePath ?? '?'}` : ''}`)
    .join('\n');
  const stateList = `${[...byPrefix.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => `- ${p} ${n} documents`).join('\n')}\n### 40 most recently written\n${recentDocs}`;

  const trustDoc = stateGet<TrustDoc>(TRUST_DOC).value;
  const trust = assess(trustDoc);
  const failures = (trustDoc?.records ?? []).filter((r) => !r.succeeded).slice(-10);
  const lessons = stateGet<LessonsDoc>(LESSONS_DOC);
  const workflows = cli(['workflow', 'list', '--json']);
  const catalog = workflows.code === 0
    ? ((JSON.parse(workflows.stdout) as { workflows: { name: string }[] }).workflows.map((w) => w.name).sort().join(', '))
    : `unavailable (exit ${workflows.code})`;

  const dir = process.env.ARTIFACTS_DIR;
  const fullPath = dir ? `${dir}/runs.md` : '';
  if (dir) writeFileSync(fullPath, `${runs.map((r) => runLine(r, true)).join('\n')}\n`);
  const roots = [...new Set(runs.map((r) => r.output_root).filter((v): v is string => !!v))];
  const evidence = [
    `## Runs (${runs.length} most recent, newest first, every status)`,
    'Each line: id, workflow, status, start, duration, cost, inputs, parent run, and the last thing the run said (its error, or its last script output). This list is where to start reading, not what happened.',
    `A run's transcript is \`<root>/logs/<id>.jsonl\` (node_start, node_complete, exec_output with each script's stdout, provider_event with the agents' turns, workflow_error) and its artifacts are \`<root>/artifacts/runs/<id>/\` (reports, briefs, node outputs under nodes/). Roots: ${roots.join(', ') || 'none'}.${fullPath ? ` The same list with full paths: ${fullPath}.` : ''}`,
    runs.map((r) => runLine(r, false)).join('\n') || 'none',
    '',
    `## State documents (${documents.length})`,
    listing.code === 0
      ? `List a prefix with \`archon state list --prefix <p>\`, read one with \`archon state get <name>\`. A document's history records each decision the writing runs made.\n${stateList}`
      : `unavailable (exit ${listing.code})`,
    '',
    `## Open attention items (${open.length})`,
    '### By label',
    labelCounts.join('\n') || 'no labelled items',
    '### Items',
    openList || 'none',
    '',
    `## Trust ladder: ${trust.level} (${trust.reason})`,
    failures.length === 0 ? 'No recent mission failures.' : failures.map((f) => `- ${f.at} ${f.mission} (run ${f.run})`).join('\n'),
    '',
    `## Memory (revision ${lessons.revision}, ${lessons.value?.lessons.length ?? 0} lessons)`,
    (lessons.value?.lessons ?? []).map((l) => `- ${l.text}`).join('\n') || 'empty',
    '',
    '## Workflows installed',
    catalog,
  ].join('\n');

  if (dir) writeFileSync(`${dir}/evidence.md`, `${evidence}\n`);
  emit({ evidence, lessons_revision: lessons.revision });
});
