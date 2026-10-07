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

  // A wait must follow any accepted re-run, even when another run's re-run was refused.
  it('reports requested when any run was re-run, naming the run that was refused', () => {
    const result = rerun({
      gh: {
        checks: [
          { name: 'test', state: 'FAILURE', bucket: 'fail', link: job(11) },
          { name: 'e2e', state: 'FAILURE', bucket: 'fail', link: job(12) },
        ],
        rerunFailFor: { '12': 'HTTP 409: already running' },
      },
    });
    expect(JSON.parse(result.stdout)).toEqual({
      requested: true,
      detail:
        're-ran the failed jobs of workflow run(s) 11; the re-run was refused for workflow run(s) 12 (HTTP 409: already running)',
    });
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
  // One external red the plugin cannot re-run must not block the flaky part it can.
  it('asks the plugin to re-run every failing unit it can, names the rest, never gh', () => {
    const result = rerun({
      source: 'forge',
      forge: {
        kind: 'fake',
        response: [
          forgeResponse([
            { name: 'build', state: 'red', rerun: { id: '11', attempt: 1 } },
            { name: 'ci/external', state: 'red', rerun: null },
            { name: 'lint', state: 'green', rerun: { id: '12', attempt: 1 } },
          ]),
          forgeOperation('checks.rerun', {
            target: { repo: { host: 'ghe.example.com', path: 'example/repo' }, number: 42 },
            outcome: 'applied',
            changed: true,
          }),
        ],
      },
    });
    expect(JSON.parse(result.stdout)).toEqual({
      requested: true,
      detail: 're-ran build (failure) at deadbeef; no re-run from here for ci/external',
    });
    expect(result.forge.some(call => call.includes('forge checks.rerun'))).toBe(true);
    expect(result.gh).toEqual([]);
  });

  it('requests nothing when no failing unit has a re-run group', () => {
    const result = rerun({
      source: 'forge',
      forge: { kind: 'fake', response: forgeResponse([{ name: 'ci/external', state: 'red', rerun: null }]) },
    });
    expect(JSON.parse(result.stdout)).toEqual({
      requested: false,
      detail: 'nothing re-runnable is failing; no re-run from here for ci/external',
    });
    expect(result.forge.some(call => call.includes('forge checks.rerun'))).toBe(false);
  });
});
