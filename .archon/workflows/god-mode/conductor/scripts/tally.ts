/**
 * Count what the missions achieved and append every outcome to the trust ladder.
 * Bound inputs: INPUTS_MISSIONS, the plan's missions, and INPUTS_RESULTS, the
 * fan-out's results in the same item order, so a crashed child's slot is matched to
 * its mission by position.
 */
import { writeFileSync } from 'node:fs';
import { statePatch } from '../../.shared/archon.ts';
import { tally } from '../../.shared/conductor.ts';
import { emit, json, run } from '../../.shared/io.ts';
import type { Mission } from '../../.shared/mission.ts';
import { TRUST_DOC } from '../../.shared/trust.ts';

run('god-mode tally', () => {
  const missions = json(process.env.INPUTS_MISSIONS) as Mission[];
  const results = json(process.env.INPUTS_RESULTS) as unknown[];
  const t = tally(missions, results);
  const at = new Date().toISOString();
  const runId = process.env.WORKFLOW_ID ?? '';
  if (t.outcomes.length > 0) {
    // Appends commute, so concurrent god-mode runs never lose each other's outcomes.
    statePatch(
      TRUST_DOC,
      t.outcomes.map((o) => ({ op: 'append' as const, path: '/records', value: { at, run: runId, ...o } })),
    );
  }
  const dir = process.env.ARTIFACTS_DIR;
  if (dir) writeFileSync(`${dir}/missions.md`, `# Missions\n\n${t.report}\n`);
  const { outcomes: _recorded, ...out } = t;
  emit(out);
});
