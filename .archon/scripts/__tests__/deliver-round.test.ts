/**
 * Deliver's `round` node under the pack's `ci` setting: with `ci: none` a round is
 * delivered only when the CI agent recorded a validation that passed at the head it
 * handed off, because the merge gate merges nothing else. Run as the engine runs it,
 * from its bound inputs.
 */
import { describe, expect, it } from 'bun:test';
import { packScriptRunner } from './deliver-checks-harness';

const { runPackScript } = packScriptRunner();

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

/** A round whose review passed and whose CI agent declared `ready` at `HEAD`. */
function round(ci: 'forge' | 'none', validation: { head: string; passed: boolean } | null) {
  const run = runPackScript('deliver/scripts/round', {
    inputs: {
      INPUTS_PREVIOUS: '',
      INPUTS_GREEN: 'true',
      INPUTS_PR_URL: 'https://ghe.example.com/example/repo/pull/42',
      INPUTS_REVIEW_READY: 'true',
      INPUTS_REVIEW_ACTION: 'none',
      INPUTS_REVIEW_CONTRACT_LEFT: '[]',
      INPUTS_SIMPLIFY: 'false',
      INPUTS_CI_STATE: 'ready',
      INPUTS_CI_SUMMARY: 'marked ready',
      INPUTS_CI: ci,
      // A null field arrives as empty text.
      INPUTS_CI_VALIDATION: validation === null ? '' : JSON.stringify(validation),
      INPUTS_THREADS_OPEN: '0',
      ARCHON_NODE_EXECUTION: JSON.stringify({ attempt: { checkoutStart: { kind: 'git', commit: HEAD } } }),
    },
  });
  expect({ code: run.code, stderr: run.stderr }).toEqual({ code: 0, stderr: '' });
  const { ready, done, reason } = JSON.parse(run.stdout) as { ready: boolean; done: boolean; reason: string };
  return { ready, done, reason };
}

describe("deliver's round ending when the CI agent declared ready", () => {
  const delivered = { ready: true, done: true, reason: 'delivered' };
  const unvalidated = { ready: false, done: true, reason: 'ci_other' };

  it('is delivered under ci: forge, which records no validation', () => {
    expect(round('forge', null)).toEqual(delivered);
  });

  it('is delivered under ci: none with a validation that passed at the head', () => {
    expect(round('none', { head: HEAD, passed: true })).toEqual(delivered);
  });

  it.each([
    ['no validation', null],
    ['a failed validation', { head: HEAD, passed: false }],
    ['a validation for another commit', { head: OTHER, passed: true }],
  ])('is not delivered under ci: none with %s, and runs no further round', (_name, validation) => {
    expect(round('none', validation)).toEqual(unvalidated);
  });
});
