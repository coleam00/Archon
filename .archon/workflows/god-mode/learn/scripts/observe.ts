/**
 * Gather the evidence the learner reasons from. Everything here is fact read from the
 * engine's own records; the judgment happens in `reflect`.
 *
 * Nothing here knows any pack's conventions. Run outcomes are grouped by workflow
 * name, and recurring attention is counted by every label key the open items carry,
 * whatever pack set them. That is what lets the learner improve the SDLC pack, or any
 * other pack, without god mode hardcoding their stage or label names.
 */
import { writeFileSync } from 'node:fs';
import { cli, cliJson, stateGet } from '../../.shared/archon.ts';
import { emit, run } from '../../.shared/io.ts';
import { LESSONS_DOC, type LessonsDoc } from '../../.shared/lessons.ts';
import { assess, TRUST_DOC, type TrustDoc } from '../../.shared/trust.ts';

interface RunRow {
  id?: string;
  workflow_name?: string;
  status?: string;
  outcome?: string | null;
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

/** Keys whose counts are worth reporting: one token, as the engine requires. */
const LABEL_KEY = /^[^\s=]+$/;

function items(raw: unknown): AttentionItem[] {
  if (Array.isArray(raw)) return raw as AttentionItem[];
  const wrapped = (raw as { items?: unknown } | null)?.items;
  if (Array.isArray(wrapped)) return wrapped as AttentionItem[];
  throw new Error('workflow attention --json returned neither a list nor { items }');
}

function firstLine(text: string | undefined): string {
  const line = (text ?? '').split('\n')[0] ?? '';
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

run('learn observe', () => {
  const runs = (cliJson(['workflow', 'runs', '--json', '--limit', '200']) as { runs?: RunRow[] }).runs ?? [];
  const byWorkflow = new Map<string, Record<string, number>>();
  for (const r of runs) {
    const key = r.workflow_name ?? 'unknown';
    const counts = byWorkflow.get(key) ?? {};
    const bucket = `${r.status ?? 'unknown'}${r.outcome ? `/${r.outcome}` : ''}`;
    counts[bucket] = (counts[bucket] ?? 0) + 1;
    byWorkflow.set(key, counts);
  }
  const runTable = [...byWorkflow.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([w, c]) => `- ${w}: ${Object.entries(c).map(([k, n]) => `${k} ${n}`).join(', ')}`)
    .join('\n');
  const failedRuns = runs
    .filter((r) => r.status === 'failed' || r.outcome === 'failed')
    .slice(0, 15)
    .map((r) => `- ${r.workflow_name ?? 'unknown'} run ${r.id ?? '?'} (${r.status}${r.outcome ? `/${r.outcome}` : ''})`)
    .join('\n');

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
  const byWorkflowNode = new Map<string, number>();
  for (const i of open) {
    const k = `${i.workflow ?? 'unknown'} @ ${i.node ?? '?'} (${i.kind ?? '?'})`;
    byWorkflowNode.set(k, (byWorkflowNode.get(k) ?? 0) + 1);
  }
  const sample = open
    .slice(0, 25)
    .map((i) => `- ${i.workflow ?? '?'} run ${i.runId ?? '?'} @ ${i.node ?? '?'} ${JSON.stringify(i.labels ?? {})}: ${firstLine(i.message)}`)
    .join('\n');

  const trustDoc = stateGet<TrustDoc>(TRUST_DOC).value;
  const trust = assess(trustDoc);
  const failures = (trustDoc?.records ?? []).filter((r) => !r.succeeded).slice(-10);
  const lessons = stateGet<LessonsDoc>(LESSONS_DOC);
  const workflows = cli(['workflow', 'list', '--json']);
  const catalog = workflows.code === 0
    ? ((JSON.parse(workflows.stdout) as { workflows: { name: string }[] }).workflows.map((w) => w.name).sort().join(', '))
    : `unavailable (exit ${workflows.code})`;

  const evidence = [
    `## Recent runs in this project (${runs.length})`,
    runTable || 'none',
    '',
    '### Recent failures',
    failedRuns || 'none',
    '',
    `## Open attention items (${open.length})`,
    '### By label',
    labelCounts.join('\n') || 'no labelled items',
    '### By workflow and node',
    [...byWorkflowNode.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `- ${k}: ${n}`).join('\n') || 'none',
    '### Oldest items',
    sample || 'none',
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

  const dir = process.env.ARTIFACTS_DIR;
  if (dir) writeFileSync(`${dir}/evidence.md`, `${evidence}\n`);
  emit({ evidence, lessons_revision: lessons.revision });
});
