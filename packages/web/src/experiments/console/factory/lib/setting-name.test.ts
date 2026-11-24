import { describe, expect, test } from 'bun:test';
import { settingLabel } from './setting-name';

describe('settingLabel', () => {
  test('reads a key in sentence case, underscores and hyphens as spaces', () => {
    expect(
      ['triage_policy', 'checks_file', 'validate-command', '_private', 'already Spaced'].map(
        settingLabel
      )
    ).toEqual(['Triage policy', 'Checks file', 'Validate command', 'Private', 'Already Spaced']);
  });
});
