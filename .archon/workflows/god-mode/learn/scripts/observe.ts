/**
 * Gather the evidence the learner reasons from. Everything here is fact read from the
 * engine's own records; the judgment happens in `reflect`.
 */
import { writeFileSync } from 'node:fs';
import { cli, cliJson, stateGet } from '../../.shared/archon.ts';
import { emit, run } from '../../.shared/io.ts';
import { LESSONS_DOC, type LessonsDoc } from '../../.shared/lessons.ts';
import { assess, TRUST_DOC, type TrustDoc } from '../../.shared/trust.ts';

interface RunRow {
  workflow_name?: string;
  status?: string;
  outcome?: string | null;
}

/** Bounded raw CLI text for the agent to read, with the exit code kept as evidence. */
function raw(args: string[]): string {
  const r = cli(args);
  const body = `${r.stdout}${r.stderr}`.trim();
  return `$ archon ${args.join(' ')} (exit ${r.code})\n${body.length > 6000 ? `${body.slice(0, 6000)}…` : body}`;
}

run('learn observe', () => {
  const runs = (cliJson(['workflow', 'runs', '--json', '--limit', '100']) as { runs?: RunRow[] }).runs ?? [];
  const byWorkflow = new Map<string, Record<string, number>>();
  for (const r of runs) {
    const key = r.workflow_name ?? 'unknown';
    const counts = byWorkflow.get(key) ?? {};
    const bucket = `${r.status ?? 'unknown'}${r.outcome ? `/${r.outcome}` : ''}`;
    counts[bucket] = (counts[bucket] ?? 0) + 1;
    byWorkflow.set(key, counts);
  }
  const runTable = [...byWorkflow.entries()]
    .map(([w, c]) => `- ${w}: ${Object.entries(c).map(([k, n]) => `${k} ${n}`).join(', ')}`)
    .join('\n');

  const trustDoc = stateGet<TrustDoc>(TRUST_DOC).value;
  const trust = assess(trustDoc);
  const failures = (trustDoc?.records ?? []).filter((r) => !r.succeeded).slice(-10);
  const lessons = stateGet<LessonsDoc>(LESSONS_DOC);

  const evidence = [
    `## Recent runs in this project (${runs.length})`,
    runTable || 'none',
    '',
    '## Recurring attention items',
    raw(['workflow', 'attention', '--json', '--count-by', 'label:god-mode']),
    '',
    raw(['workflow', 'attention', '--json']),
    '',
    `## Trust ladder: ${trust.level} (${trust.reason})`,
    failures.length === 0 ? 'No recent mission failures.' : failures.map((f) => `- ${f.at} ${f.mission} (run ${f.run})`).join('\n'),
    '',
    `## Memory (revision ${lessons.revision}, ${lessons.value?.lessons.length ?? 0} lessons)`,
    (lessons.value?.lessons ?? []).map((l) => `- ${l.text}`).join('\n') || 'empty',
  ].join('\n');

  const dir = process.env.ARTIFACTS_DIR;
  if (dir) writeFileSync(`${dir}/evidence.md`, `${evidence}\n`);
  emit({ evidence, lessons_revision: lessons.revision });
});
