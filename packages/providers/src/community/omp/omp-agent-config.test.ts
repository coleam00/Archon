import { describe, expect, test } from 'bun:test';

import { parseOmpAgentDefaultModelFromYaml } from './omp-agent-config';

describe('parseOmpAgentDefaultModelFromYaml', () => {
  test('reads modelRoles.default', () => {
    const yaml = 'modelRoles:\n  default: cursor/composer-2.5\n';
    expect(parseOmpAgentDefaultModelFromYaml(yaml)).toBe('cursor/composer-2.5');
  });

  test('returns undefined when missing', () => {
    expect(parseOmpAgentDefaultModelFromYaml('setupVersion: 1\n')).toBeUndefined();
  });
});
