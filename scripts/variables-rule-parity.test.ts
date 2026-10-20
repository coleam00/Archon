/**
 * The rule about user-controlled variables in an exec node ships twice: in the bundled
 * `archon-cli` skill and on the docs site. Both copies reach users — the skill is
 * written to every install by `archon skill add` — so an edit to one that misses the
 * other ships a false promise. This compares the two copies' statements of the rule.
 */
import { describe, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..');
const COPIES = [
  '.claude/skills/archon-cli/authoring/variables.md',
  'packages/docs-web/src/content/docs/reference/variables.md',
];

/** The passages that state the rule: the ones naming the user-controlled variables. */
function rulePassages(file: string): string[] {
  const passages = readFileSync(join(REPO, file), 'utf8')
    .split('\n')
    .filter(line => /user-controlled variables \(/i.test(line));
  if (passages.length === 0) throw new Error(`${file} states no user-controlled variable rule`);
  return passages;
}

/** The variables one passage names. */
function namedVariables(passage: string): string[] {
  const group = /user-controlled variables \(([^)]*)\)/i.exec(passage);
  if (group === null) throw new Error(`no parenthesised variable list in: ${passage}`);
  return [...group[1].matchAll(/\$([A-Z_]+)/g)].map(match => match[1]);
}

describe('the user-controlled variable rule', () => {
  const passages = COPIES.flatMap(file => rulePassages(file).map(text => ({ file, text })));

  test('every shipped copy names the same variables', () => {
    const expected = [...namedVariables(passages[0].text)].sort();
    for (const { file, text } of passages) {
      const names = [...namedVariables(text)].sort();
      if (names.join(', ') !== expected.join(', ')) {
        throw new Error(
          `${file} names ${names.join(', ')} where the other copies name ${expected.join(', ')}`
        );
      }
    }
  });

  test('no shipped copy promises a warning for a literal user-controlled variable', () => {
    for (const { file, text } of passages) {
      if (text.toLowerCase().includes('warn')) {
        throw new Error(`${file} promises a warning for a literal user-controlled variable`);
      }
    }
  });
});
