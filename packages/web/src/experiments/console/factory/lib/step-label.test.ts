import { describe, expect, test } from 'bun:test';
import { stepLabel } from './step-label';

const VIEW = {
  steps: { 'stage-build': { build__build: 'Writes or fixes the change' } },
};

describe('stepLabel', () => {
  test('a step the view names reads as that name', () => {
    expect(stepLabel(VIEW, 'stage-build', 'build__build')).toBe('Writes or fixes the change');
  });

  test('a doubled include name collapses', () => {
    expect(stepLabel(VIEW, 'other', 'build__build')).toBe('build');
  });

  test('an include reads as include: inner', () => {
    expect(stepLabel(VIEW, 'other', 'judge__inner')).toBe('judge: inner');
  });

  test('an unknown id reads with separators as spaces, and never as nothing', () => {
    expect(stepLabel(VIEW, 'deliver', 'rounds.mystery__mystery')).toBe('mystery');
    expect(stepLabel(VIEW, 'deliver', 'some_odd-id')).toBe('some odd id');
    expect(stepLabel(VIEW, 'deliver', '__')).toBe('__');
  });
});
