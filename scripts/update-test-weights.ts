import { join } from 'node:path';

/**
 * Rewrites `scripts/test-weights.json` from the Windows test jobs of one CI run:
 *
 *   bun scripts/update-test-weights.ts <run-id>
 *
 * `package-tests.ts` ends every group with a `◀ <package> <first selector> <seconds>s` line, and
 * `partitionTestGroups` splits a shard into parts by these times. Windows is the slower leg, so
 * its times decide the split for both. The weights only balance the parts; a stale or missing
 * weight never drops a group, so refresh them when a part runs visibly longer than its sibling.
 */

const REPO = 'coleam00/Archon';
const WEIGHTS_PATH = join(import.meta.dir, 'test-weights.json');
const TIMING_LINE = /◀ (@[\w-]+\/[\w-]+) (\S+) (\d+(?:\.\d+)?)s\s*$/;

function gh(path: string): string {
  const result = Bun.spawnSync(['gh', 'api', path], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`gh api ${path} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}

const runId = Bun.argv[2];
if (runId === undefined || !/^\d+$/.test(runId)) {
  console.error('Usage: bun scripts/update-test-weights.ts <run-id>');
  process.exit(1);
}

const { jobs } = JSON.parse(gh(`repos/${REPO}/actions/runs/${runId}/jobs?per_page=100`)) as {
  jobs: { id: number; name: string; conclusion: string | null }[];
};
const windowsTestJobs = jobs.filter(job => /^test \(windows-latest\b/.test(job.name));
if (windowsTestJobs.length === 0) throw new Error(`Run ${runId} has no Windows test jobs`);

const weights: Record<string, Record<string, number>> = {};
for (const job of windowsTestJobs) {
  if (job.conclusion !== 'success')
    throw new Error(`${job.name} finished ${String(job.conclusion)}`);
  for (const line of gh(`repos/${REPO}/actions/jobs/${String(job.id)}/logs`).split('\n')) {
    const match = TIMING_LINE.exec(line);
    if (match === null) continue;
    const [, packageName, selector, seconds] = match;
    weights[packageName] ??= {};
    weights[packageName][selector] = Number(seconds);
  }
}

const sorted = Object.fromEntries(
  Object.keys(weights)
    .sort()
    .map(name => [
      name,
      Object.fromEntries(Object.entries(weights[name]).sort(([a], [b]) => (a < b ? -1 : 1))),
    ])
);
await Bun.write(WEIGHTS_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
console.log(
  `Wrote ${String(Object.values(weights).reduce((n, w) => n + Object.keys(w).length, 0))} group weights to ${WEIGHTS_PATH}`
);
