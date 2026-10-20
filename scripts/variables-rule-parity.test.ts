/**
 * The rule about user-controlled variables in an exec node ships twice: in the bundled
 * `archon-cli` skill and on the docs site. Both copies reach users — the skill is
 * written to every install by `archon skill add` — so an edit to one that misses the
 * other ships a false promise. This compares the two copies' statements of the rule:
 * the variables they name, the environment variables they promise for them, and
 * whether either still promises a warning the engine no longer emits.
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
  const names = [...group[1].matchAll(/\$([A-Z_]+)/g)].map(match => match[1]);
  if (names.length === 0) throw new Error(`no variables named in: ${passage}`);
  return names;
}

/**
 * The environment variables one passage promises for them: the names it lists after
 * "environment variables". The clause ends at the passage's "plus", where the list
 * turns from the user-controlled variables to the engine's own keys.
 */
function namedEnvironment(passage: string): string[] {
  const clause = /environment variables\b(.*)/i.exec(passage);
  if (clause === null) throw new Error(`no environment variable list in: ${passage}`);
  const promised = clause[1].split(/\bplus\b/i)[0];
  const names = [...promised.matchAll(/`([A-Z_]+)`/g)].map(match => match[1]);
  if (names.length === 0) throw new Error(`no environment variables named in: ${passage}`);
  return names;
}

/** Every variable the copies treat as user-controlled: the substituted names and their env forms. */
function userControlledVariables(passages: readonly { text: string }[]): string[] {
  const names = new Set<string>();
  for (const { text } of passages) {
    for (const name of namedVariables(text)) names.add(name);
    for (const name of namedEnvironment(text)) names.add(name);
  }
  return [...names];
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

  test('every shipped copy promises the same environment variables', () => {
    const expected = [...namedEnvironment(passages[0].text)].sort();
    for (const { file, text } of passages) {
      const names = [...namedEnvironment(text)].sort();
      if (names.join(', ') !== expected.join(', ')) {
        throw new Error(
          `${file} promises the environment variables ${names.join(', ')} where the other copies promise ${expected.join(', ')}`
        );
      }
    }
  });

  test('no shipped copy promises a warning for a literal user-controlled variable', () => {
    // The whole copy, not only the rule passages: a promise of the removed warning
    // reads the same wherever it stands.
    const variables = userControlledVariables(passages);
    for (const file of COPIES) {
      for (const line of readFileSync(join(REPO, file), 'utf8').split('\n')) {
        const named = variables.filter(variable => line.includes(`$${variable}`));
        if (named.length > 0 && /warn/i.test(line)) {
          throw new Error(`${file} promises a warning for ${named.join(', ')}`);
        }
      }
    }
  });
});
