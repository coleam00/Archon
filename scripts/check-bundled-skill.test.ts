import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_SKILL_DESCRIPTION_LENGTH, validateSkillDescription } from './check-bundled-skill';

describe('bundled skill metadata', () => {
  test('accepts the bundled archon-cli skill description', () => {
    const skill = readFileSync(
      join(import.meta.dir, '..', '.claude', 'skills', 'archon-cli', 'SKILL.md'),
      'utf8'
    );

    expect(validateSkillDescription('archon-cli', skill)).toBeUndefined();
  });

  test('rejects an empty description', () => {
    expect(validateSkillDescription('fixture', '---\ndescription: ""\n---\n')).toContain(
      'non-empty'
    );
  });

  test('rejects a description longer than the Agent Skills limit', () => {
    const skill = `---\ndescription: ${'a'.repeat(MAX_SKILL_DESCRIPTION_LENGTH + 1)}\n---\n`;

    expect(validateSkillDescription('fixture', skill)).toContain(
      `${MAX_SKILL_DESCRIPTION_LENGTH + 1}-character`
    );
  });
});
