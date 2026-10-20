/**
 * The rule about user-controlled variables in an exec node ships in three places: the
 * bundled `archon-cli` skill, the docs site's variables reference, and the script-node
 * guide. All three reach users — the skill is written to every install by `archon skill
 * add` — so an edit to one that misses the others ships a false promise.
 *
 * The engine's owner of the environment variables an exec node delivers is
 * `EXEC_NODE_ENVIRONMENT_NAMES` (`packages/workflows/src/exec-environment.ts`). This holds
 * each copy to it: the environment variables a copy promises must be ones the exec node
 * delivers, every variable a copy calls user-controlled must have an environment form the
 * copy promises, the copy must say the variables are not substituted into the source, and
 * no copy may promise a warning the engine no longer emits.
 */
import { describe, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXEC_NODE_ENVIRONMENT_NAMES } from '../packages/workflows/src/exec-environment';

const REPO = join(import.meta.dir, '..');

/**
 * The copies of the rule, and how completely each states it. The skill and the reference
 * name the whole user-controlled class and must agree on it. The guide names two examples
 * of the class, so it is held to the rule's claims and to the engine, but not to a list it
 * does not make.
 */
const COPIES = [
  { file: '.claude/skills/archon-cli/authoring/variables.md', names: 'the class' },
  { file: 'packages/docs-web/src/content/docs/reference/variables.md', names: 'the class' },
  { file: 'packages/docs-web/src/content/docs/guides/script-nodes.md', names: 'examples' },
] as const;

/** The engine's term for the variables an exec node delivers instead of substituting. */
const USER_CONTROLLED = /user-controlled/i;

/** The node kinds the rule covers, in the spelling the engine uses for them. */
const EXEC_KINDS = ['`bash:`', '`script:`'];

/** A claim that the variables are not substituted into the source, in either word order. */
const NOT_SUBSTITUTED = [
  /\b(?:not|never|except|no)\b[^.]{0,300}?\b(?:substitut|splic)/i,
  /\b(?:substitut|splic)[^.]{0,300}?\b(?:not|never|except|no)\b/i,
];

/** A promise that the engine emits something about a variable, in any wording. */
const DIAGNOSTIC =
  /\b(?:warn|notice|log|alert|diagnostic|announce|report|emit|print|inform|tell|surface|remind|signal)[A-Za-z]*(?![_\w])/gi;

/** A negation in front of a promise, which says the opposite of promising it. */
const NEGATED = /\b(?:not|never|no|without|instead of|rather than)\s*$/i;

/** The subject of a promise: the user-controlled variables, however the sentence names them. */
const ABOUT_USER_CONTROLLED = /user-controlled|literal[^.]{0,60}variable/i;

/** The markdown items of a document: paragraphs, list items, table rows and admonitions. */
function items(file: string): string[] {
  const found: string[][] = [];
  for (const chunk of readFileSync(join(REPO, file), 'utf8').split(/\n[ \t]*\n/)) {
    let current: string[] | undefined;
    for (const line of chunk.split('\n')) {
      if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line) || /^\s*\|/.test(line) || current === undefined) {
        current = [];
        found.push(current);
      }
      current.push(line);
    }
  }
  return found.map(lines => lines.join('\n').trim()).filter(line => line !== '');
}

/** The sentences of an item, so a claim is read in the sentence that makes it. */
function sentences(item: string): string[] {
  return item
    .split(/(?<=[.!?])\s+(?=[A-Z`"'(])/g)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence !== '');
}

/** The items of a copy that state the rule: the ones that talk about the user-controlled variables. */
function ruleItems(file: string): string[] {
  const found = items(file).filter(item => USER_CONTROLLED.test(item));
  if (found.length === 0) throw new Error(`${file} states no user-controlled variable rule`);
  return found;
}

/** The sentence of a rule item that says what happens to the user-controlled variables. */
function claimSentence(file: string, item: string): string {
  const sentence = sentences(item).find(candidate => USER_CONTROLLED.test(candidate));
  if (sentence === undefined) {
    throw new Error(`${file} states a user-controlled variable rule in no sentence`);
  }
  return sentence;
}

/**
 * The variables a rule item calls user-controlled: the ones it names in the sentence that
 * states the rule. A statement that names none is a summary of the rule and says nothing
 * about the class; one that names some must present them as a list, so a rewrite that
 * loses the list fails here instead of quietly shrinking what the guard compares.
 */
function attributedVariables(file: string, sentence: string): string[] {
  const names = [...sentence.matchAll(/\$([A-Z_]+)/g)].map(match => match[1]);
  if (names.length === 0) return names;
  const listed = /\([^)]*\$[A-Z_]+[^)]*\)/.test(sentence) || /like\s+`?\$/.test(sentence);
  if (!listed) {
    throw new Error(`${file} names user-controlled variables without listing them: ${sentence}`);
  }
  return names;
}

/**
 * The environment variables a rule item promises: the names it writes as environment
 * variables, in a list, in an accessor, or in both. A `with:` binding is a different
 * channel than the exec node's own environment, so `INPUTS_*` names are not promises of
 * it.
 */
function promisedEnvironment(item: string): string[] {
  const names = new Set<string>();
  for (const match of item.matchAll(/`([A-Z_]+)`/g)) names.add(match[1]);
  for (const match of item.matchAll(/process\.env\.([A-Z_]+)/g)) names.add(match[1]);
  for (const match of item.matchAll(/os\.environ\[['"]?([A-Z_]+)/g)) names.add(match[1]);
  return [...names].filter(name => !name.startsWith('INPUTS_'));
}

/** A promise of a diagnostic in a sentence, and the variables the sentence speaks about. */
function promisedDiagnostic(
  sentence: string,
  variables: ReadonlySet<string>
): { word: string; subject: string } | undefined {
  const named = [...variables].filter(variable => sentence.includes(`$${variable}`));
  if (named.length === 0 && !ABOUT_USER_CONTROLLED.test(sentence)) return undefined;
  for (const match of sentence.matchAll(DIAGNOSTIC)) {
    if (NEGATED.test(sentence.slice(0, match.index))) continue;
    const subject = named.length > 0 ? named.join(', ') : 'a user-controlled variable';
    return { word: match[0], subject };
  }
  return undefined;
}

describe('the user-controlled variable rule', () => {
  const copies = COPIES.map(copy => ({
    ...copy,
    items: ruleItems(copy.file),
  }));

  /** The variables a copy calls user-controlled, across its rule items. */
  const namedVariables = (copy: { file: string; items: string[] }): Set<string> =>
    new Set(
      copy.items.flatMap(item => attributedVariables(copy.file, claimSentence(copy.file, item)))
    );

  /** The environment variables a copy promises, across its rule items. */
  const promisedNames = (copy: { file: string; items: string[] }): Set<string> =>
    new Set(copy.items.flatMap(promisedEnvironment));

  /** The user-controlled class: the variables the copies that name it name. */
  const theClass = (): string[] => {
    const classCopies = copies.filter(copy => copy.names === 'the class');
    return [...namedVariables(classCopies[0])].sort();
  };

  test('every copy states the rule for both exec node kinds', () => {
    for (const copy of copies) {
      for (const kind of EXEC_KINDS) {
        if (!copy.items.some(item => item.includes(kind))) {
          throw new Error(`${copy.file} states no user-controlled variable rule for ${kind}`);
        }
      }
    }
  });

  test('every copy states that the user-controlled variables are not substituted', () => {
    for (const copy of copies) {
      for (const item of copy.items) {
        const sentence = claimSentence(copy.file, item);
        if (!NOT_SUBSTITUTED.some(claim => claim.test(sentence))) {
          throw new Error(
            `${copy.file} does not say the user-controlled variables are not substituted: ${sentence}`
          );
        }
      }
    }
  });

  test('every environment variable a copy promises is one the exec node delivers', () => {
    for (const copy of copies) {
      for (const item of copy.items) {
        for (const name of promisedEnvironment(item)) {
          if (!EXEC_NODE_ENVIRONMENT_NAMES.has(name)) {
            throw new Error(
              `${copy.file} promises the environment variable ${name}, which the exec node does not deliver`
            );
          }
        }
      }
    }
  });

  test('every variable a copy calls user-controlled has an environment form it promises', () => {
    for (const copy of copies) {
      const named = namedVariables(copy);
      if (named.size === 0) {
        throw new Error(`${copy.file} names no user-controlled variable`);
      }
      const promised = promisedNames(copy);
      for (const name of named) {
        if (!promised.has(name)) {
          throw new Error(
            `${copy.file} calls ${name} user-controlled but promises no ${name} environment variable`
          );
        }
      }
    }
  });

  test('the copies that name the class agree on it', () => {
    const expected = theClass();
    for (const copy of copies.filter(copy => copy.names === 'the class')) {
      const names = [...namedVariables(copy)].sort();
      if (names.join(', ') !== expected.join(', ')) {
        throw new Error(
          `${copy.file} names ${names.join(', ')} where the other copies name ${expected.join(', ')}`
        );
      }
    }
  });

  test('a copy that names examples names examples of the class', () => {
    const expected = theClass();
    for (const copy of copies.filter(copy => copy.names !== 'the class')) {
      for (const name of namedVariables(copy)) {
        if (!expected.includes(name)) {
          throw new Error(
            `${copy.file} names ${name}, which the user-controlled class does not contain`
          );
        }
      }
    }
  });

  test('no copy promises a warning for a literal user-controlled variable', () => {
    // The whole copy, not only the rule items: a promise of the removed warning reads
    // the same wherever it stands.
    const variables = new Set(copies.flatMap(copy => [...namedVariables(copy)]));
    for (const copy of COPIES) {
      for (const item of items(copy.file)) {
        // A code example reads whatever it likes; a promise of the removed warning is prose.
        if (item.startsWith('```')) continue;
        for (const sentence of sentences(item)) {
          const promise = promisedDiagnostic(sentence, variables);
          if (promise === undefined) continue;
          throw new Error(
            `${copy.file} promises ${promise.word} for ${promise.subject}: ${sentence}`
          );
        }
      }
    }
  });
});
