/**
 * Settle the charter, read the trust ladder, and decide whether a person sees the plan.
 * Bound inputs: INPUTS_CHARTER, and INPUTS_RECHARTER (`null` when no clarification ran).
 */
import { writeFileSync } from 'node:fs';
import { stateGet } from '../../.shared/archon.ts';
import { type Charter, plan, standingCharter } from '../../.shared/conductor.ts';
import { emit, json, run } from '../../.shared/io.ts';
import { assess, TRUST_DOC, type TrustDoc } from '../../.shared/trust.ts';

run('god-mode plan', () => {
  const charter = standingCharter(
    json(process.env.INPUTS_CHARTER) as Charter,
    json(process.env.INPUTS_RECHARTER) as Charter | null,
  );
  const trust = assess(stateGet<TrustDoc>(TRUST_DOC).value);
  const result = plan(charter, trust);
  const dir = process.env.ARTIFACTS_DIR;
  if (dir) writeFileSync(`${dir}/plan.md`, `# God-mode plan\n\n${result.message}\n`);
  emit(result);
});
