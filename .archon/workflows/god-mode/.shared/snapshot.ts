/**
 * The repository's automation health, as the engine itself reports it: which workflows
 * its validator rejects and which declared fixtures fail. A revision is compared against
 * the snapshot taken before it, so pre-existing failures never block it and new ones
 * always do.
 */

import { cli } from './archon.ts';
import type { Snapshot } from './revise.ts';

function report<T>(args: string[]): T {
  const r = cli(args);
  // Both commands exit non-zero when anything fails; that is data here, not an error.
  // Output that is not their JSON report is: without it there is no baseline to compare.
  const start = r.stdout.indexOf('{');
  if (start < 0) throw new Error(`archon ${args.join(' ')} printed no JSON report (exit ${r.code}): ${r.stderr.trim()}`);
  return JSON.parse(r.stdout.slice(start)) as T;
}

export function snapshot(): Snapshot {
  const validated = report<{ results: { workflowName: string; valid: boolean }[] }>(['validate', 'workflows', '--json']);
  const tested = report<{ results: { fixture: string; pass: boolean }[] }>(['workflow', 'test', '--json']);
  return {
    invalid: validated.results.filter((r) => !r.valid).map((r) => r.workflowName).sort(),
    failing: tested.results.filter((r) => !r.pass).map((r) => r.fixture).sort(),
  };
}
