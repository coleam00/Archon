import { describe, expect, it } from 'bun:test';
import { runPackScript, type ScriptRun } from './deliver-checks-harness';

const probe = (unstarted: string): ScriptRun =>
  runPackScript('prp/scripts/probe', {
    gh: { checks: [], rollup: 0, workflows: 1 },
    inputs: { INPUTS_UNSTARTED: unstarted },
  });

describe('archon-prp CI probe', () => {
  it('keeps waiting while configured CI has not registered a check yet', () => {
    const result = probe('');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ state: 'pending', unstarted: 1 });
  });

  // Without the bound the loop exhausts max_iterations and fails the run instead of
  // letting the outcome report ci_missing.
  it('concludes once CI has stayed unstarted for its bound', () => {
    const result = probe('4');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ state: 'concluded', unstarted: 5 });
  });
});
