import { describe, expect, it } from 'bun:test';
import { forgeOperation, forgeResponse, runDeliverScript } from './deliver-checks-harness';

const rerun = runDeliverScript.bind(null, 'rerun-failed');
const job = (run: number): string =>
  `https://github.com/example/repo/actions/runs/${String(run)}/job/9`;

describe('rerun-failed on the default gh source', () => {
  it('re-runs the failed jobs of each workflow run a failing check belongs to, never a passing one', () => {
    const result = rerun({
      gh: {
        checks: [
          { name: 'test (ubuntu)', state: 'FAILURE', bucket: 'fail', link: job(11) },
          { name: 'test (windows)', state: 'CANCELLED', bucket: 'cancel', link: job(11) },
          { name: 'lint', state: 'SUCCESS', bucket: 'pass', link: job(12) },
        ],
      },
    });
    expect(JSON.parse(result.stdout)).toEqual({
      requested: true,
      detail: 're-ran the failed jobs of workflow run(s) 11',
    });
    expect(result.gh.filter(call => call.startsWith('run rerun'))).toEqual([
      'run rerun 11 --failed --repo ghe.example.com/example/repo',
    ]);
    expect(result.forge).toEqual([]);
  });

  it('names a failing check no workflow run owns instead of re-running it', () => {
    const result = rerun({
      gh: { checks: [{ name: 'ci/external', state: 'FAILURE', bucket: 'fail', link: 'https://ci.example/b/1' }] },
    });
    expect(JSON.parse(result.stdout)).toEqual({
      requested: false,
      detail: 'nothing re-runnable is failing; no re-run from here for ci/external',
    });
    expect(result.gh.some(call => call.startsWith('run rerun'))).toBe(false);
  });

  it('reports a refused re-run as not requested, with the reason, instead of failing the run', () => {
    const result = rerun({
      gh: {
        checks: [{ name: 'test', state: 'FAILURE', bucket: 'fail', link: job(11) }],
        rerunFail: 'HTTP 403: Resource not accessible',
      },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ requested: false });
    expect(result.stderr).toContain('HTTP 403');
  });
});

describe('rerun-failed on the opt-in forge source', () => {
  it('asks the plugin to re-run every failing unit, never gh', () => {
    const result = rerun({
      source: 'forge',
      forge: {
        kind: 'fake',
        response: [
          forgeResponse([
            { name: 'build', state: 'red' },
            { name: 'lint', state: 'green' },
          ]),
          forgeOperation('checks.rerun', {
            target: { repo: { host: 'ghe.example.com', path: 'example/repo' }, number: 42 },
            outcome: 'applied',
            changed: true,
          }),
        ],
      },
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ requested: true });
    expect(result.forge.some(call => call.includes('forge checks.rerun'))).toBe(true);
    expect(result.gh).toEqual([]);
  });
});
