import { describe, expect, it } from 'bun:test';
import { forgeResponse, runDeliverScript } from './deliver-checks-harness';

const note = runDeliverScript.bind(null, 'ci-note');

describe('ci-note', () => {
  it('reports concluded failures and running checks from the default gh source', () => {
    const result = note({
      gh: {
        checks: [
          { name: 'lint', state: 'FAILURE', bucket: 'fail' },
          { name: 'test', state: 'IN_PROGRESS', bucket: 'pending' },
          { name: 'build', state: 'SUCCESS', bucket: 'pass' },
        ],
      },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Concluded non-green checks:\n- lint (failure)');
    expect(result.stdout).toContain('1 check(s) still running');
    expect(result.forge).toEqual([]);
  });

  it('proceeds without evidence on a failed read but tells the operator why', () => {
    const result = note({ gh: { checks: 'fail', rollup: 'fail' } });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No CI evidence is available for this round (the check read failed)');
    expect(result.stderr).toContain('ci-note: could not read check state: HTTP 502');
  });

  it('reads through the forge CLI only when selected', () => {
    const result = note({
      source: 'forge',
      forge: { kind: 'fake', response: forgeResponse([{ name: 'ext', state: 'red' }]) },
    });
    expect(result.stdout).toContain('at deadbeef');
    expect(result.stdout).toContain('- ext (failure)');
    expect(result.gh).toEqual([]);
  });

  it('surfaces a selected forge source that has no plugin', () => {
    const result = note({ source: 'forge', forge: { kind: 'no-plugin' } });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('ARCHON_SDLC_FORGE=forge');
    expect(result.stderr).toContain('no forge plugin claims ghe.example.com');
    expect(result.gh).toEqual([]);
  });
});
