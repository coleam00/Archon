/**
 * The green gate's refusals must say what happened and what to do next, so the
 * next reader (a person, or the loop routing the item) does not have to dig.
 */
import { describe, expect, it } from 'bun:test';
import { runPackScript } from './deliver-checks-harness';

function gate(inputs: Record<string, string>): ReturnType<typeof runPackScript> {
  return runPackScript('deliver/scripts/gate-green', {
    inputs: { INPUTS_STAGE: 'The implementation', INPUTS_SUMMARY: '', ...inputs },
  });
}

describe('gate-green', () => {
  it('passes green whatever the summary says', () => {
    const result = gate({ INPUTS_GREEN: 'true', INPUTS_RED_CAUSE: '' });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ gate: 'green', red_cause: '' });
  });

  it('refuses not-green with no cause as unfinished work, carrying the agent account', () => {
    const result = gate({
      INPUTS_GREEN: 'false',
      INPUTS_RED_CAUSE: '',
      INPUTS_SUMMARY: 'Unmet: the contrast criterion measures 1.07x against 1.5x.',
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('treated as unfinished work');
    expect(result.stderr).toContain('Unmet: the contrast criterion');
    expect(result.stderr).toContain('say so on the work item');
  });

  it('still refuses red the change introduced', () => {
    const result = gate({ INPUTS_GREEN: 'false', INPUTS_RED_CAUSE: 'introduced', INPUTS_SUMMARY: 'x' });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Refusing to open or advance a pull request on red work');
  });

  it('passes inherited red that names its evidence', () => {
    const result = gate({
      INPUTS_GREEN: 'false',
      INPUTS_RED_CAUSE: 'inherited',
      INPUTS_SUMMARY: 'lint was red at the base commit',
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ red_cause: 'inherited' });
  });
});
