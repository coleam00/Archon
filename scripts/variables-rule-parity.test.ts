/**
 * The rule about user-controlled variables in an exec node ships as prose: the docs site's
 * pages and the bundled `archon-cli` skill, which `archon skill add` writes to every install.
 * This guard derives the copies from the prose that ships, reads the claims each copy makes,
 * and holds them to the engine.
 *
 * The copies are the documents that state the rule. The guard reads every document in the
 * surfaces the rule ships through, so a document that starts stating the rule joins the set
 * instead of escaping it, and every copy is a build input
 * (`scripts/should-run-test-suite.ts`), so changing a copy runs this guard.
 *
 * Every fact the guard holds a copy to belongs to the engine:
 * - `EXEC_NODE_ENVIRONMENT_NAMES` (`packages/workflows/src/exec-environment.ts`) is the bag an
 *   exec node delivers;
 * - `substituteWorkflowVariables` (`packages/workflows/src/workflow-variables.ts`) says which of
 *   those names the engine splices into a source, so the user-controlled class — the names it
 *   leaves out — comes from the engine, not from the copies that name it;
 * - `inputEnvKey` (`packages/workflows/src/schemas/dag-node.ts`) owns the `with:` binding prefix,
 *   a channel of its own that the exec node's bag does not carry;
 * - `ENVIRONMENT_READ_PATTERNS` (`packages/workflows/src/exec-input-validation.ts`) owns the
 *   accessor spellings a copy may promise a variable in.
 *
 * A copy is read as claims, not as shapes: the statements that speak about the class, the
 * variables they name, the environment they promise, and what they say happens to them. A
 * statement the guard cannot read fails loudly rather than shrinking what it compares.
 */
import { describe, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXEC_NODE_ENVIRONMENT_NAMES } from '../packages/workflows/src/exec-environment';
import { ENVIRONMENT_READ_PATTERNS } from '../packages/workflows/src/exec-input-validation';
import { inputEnvKey } from '../packages/workflows/src/schemas/dag-node';
import { substituteWorkflowVariables } from '../packages/workflows/src/workflow-variables';
import { shouldRunTestSuite } from './should-run-test-suite';

const REPO = join(import.meta.dir, '..');

/** The surfaces the rule ships through: the docs site's pages and the bundled skill. */
const DOCS_PAGES = 'packages/docs-web/src/content/docs';
const BUNDLED_SKILL = '.claude/skills/archon-cli';

/** The node kinds an exec node comes in, in the spelling the engine uses for them. */
const EXEC_KINDS = { bash: '`bash:`', script: '`script:`' } as const;
type ExecKind = keyof typeof EXEC_KINDS;

/** The `with:` binding channel's prefix, read from the engine that owns it. */
const BINDING_PREFIX = inputEnvKey('');

/** The names the engine delivers but never splices into an exec node's source. */
const USER_CONTROLLED = userControlledNames();

/** A sentence that says the names it lists are environment variables. */
const PROMISES_ENVIRONMENT = /\b(?:environment variables?|env vars?)\b/i;

/** A backticked name, as the copies write an environment variable. */
const BACKTICKED_NAME = /`([A-Z][A-Z0-9_]*)`/g;

/**
 * A quoted shell access: the shell spelling a copy promises a value in. A bare `$NAME` is the
 * variable reference the engine leaves literal in a source, not a promise of the environment.
 */
const SHELL_ACCESS = /"\\?\$\{?([A-Z][A-Z0-9_]*)/g;

/** The words a copy uses to say that a value is spliced into the source. */
const SUBSTITUTION = /\b(?:substitut|splic|interpolat)/i;

/**
 * A negation that governs the substitution word: the claim that the variables are not spliced
 * into the source. A negation that merely sits near the word says nothing about it.
 */
const NEGATED_SUBSTITUTION =
  /\b(?:not|never|no)\b[\s*_`"'-]{0,4}(?:[a-z]+-)?(?:substitut|splic|interpolat)/i;

/**
 * The verbs a copy uses to promise that the engine emits something about a variable. Lower
 * case only: an environment variable named `LOG_DIR` is not a promise to log anything.
 */
const EMISSION =
  /\b(?:warn|notice|log|alert|flag|report|emit|print|inform|tell|surface|remind|signal|announce|diagnos)[a-z]*/g;

/** A negation in front of a claim, which says the opposite of promising it. */
const NEGATED_CLAIM = /\b(?:not|never|no|without|instead of|rather than|no longer)\s*$/i;

/** A sentence whose subject is the engine makes a claim about what the engine does. */
const ENGINE_SUBJECT = /^(?:archon\b|the engine\b|the [^.]*\bnode\b|archon's\b)/i;

/** A statement that enumerates the class in a list, rather than naming examples of it. */
const ENUMERATES_CLASS = /\([^)]*\$[A-Z_]+[^)]*\)/;

/** A statement that names examples of the class rather than the whole of it. */
const NAMES_EXAMPLES = /\blike\s+`?\$/;

interface Statement {
  text: string;
  sentences: string[];
}

interface Document {
  file: string;
  statements: Statement[];
}

describe('the user-controlled variable rule', () => {
  const documents = shippedDocuments();
  const copies = documents.filter(document => isCopy(document));

  test('the shipped prose states the rule', () => {
    if (copies.length === 0) {
      throw new Error('No shipped document states the user-controlled variable rule');
    }
  });

  test('every copy is a build input, so changing a copy runs this guard', () => {
    for (const copy of copies) {
      if (!shouldRunTestSuite([copy.file])) {
        throw new Error(
          `${copy.file} states the rule but is not a build input, so changing it would not run this guard`
        );
      }
    }
  });

  test('every environment variable a copy promises is one the exec node delivers', () => {
    for (const document of documents) {
      for (const statement of statementsAboutClass(document)) {
        for (const name of allPromised(statement)) {
          if (!EXEC_NODE_ENVIRONMENT_NAMES.has(name)) {
            throw new Error(
              `${document.file} promises the environment variable ${name}, which the exec node does not deliver`
            );
          }
        }
      }
    }
  });

  test('every copy states the rule for both exec node kinds', () => {
    for (const copy of copies) {
      for (const kind of Object.keys(EXEC_KINDS) as ExecKind[]) {
        const states = copy.statements.some(
          statement => kindsMentioned(statement).has(kind) && promisesKind(statement, kind)
        );
        if (!states) {
          throw new Error(
            `${copy.file} states no user-controlled variable rule for ${EXEC_KINDS[kind]}`
          );
        }
      }
    }
  });

  test('every copy states that the variables are not substituted into the source', () => {
    for (const copy of copies) {
      for (const statement of ruleStatements(copy)) {
        assertNamesTheClass(copy, statement);
        assertNotSubstituted(copy, statement);
      }
    }
  });

  test('the copies agree on the user-controlled class', () => {
    const enumerations = copies.flatMap(copy =>
      ruleStatements(copy)
        .filter(enumeratesClass)
        .map(statement => ({ copy, names: classClaim(statement) }))
    );
    if (enumerations.length === 0) {
      throw new Error('No copy names which variables are user-controlled');
    }
    const expected = [...enumerations[0].names].sort();
    for (const { copy, names } of enumerations) {
      assertSameClass(copy, names, expected);
    }
    for (const copy of copies) {
      for (const statement of ruleStatements(copy)) {
        assertNamesExamplesOfTheClass(copy, statement, expected);
      }
    }
  });

  test('every variable a copy calls user-controlled has an environment form it promises', () => {
    for (const copy of copies) {
      for (const statement of ruleStatements(copy)) {
        const promised = allPromised(statement);
        for (const name of classClaim(statement)) {
          if (!promised.has(name)) {
            throw new Error(
              `${copy.file} calls ${name} user-controlled but promises no ${name} environment variable`
            );
          }
        }
      }
    }
  });

  test('every variable a copy says is substituted into the source is substituted by the engine', () => {
    for (const copy of copies) {
      for (const statement of ruleStatements(copy)) {
        for (const sentence of statement.sentences) {
          if (!SUBSTITUTION.test(sentence) || NEGATED_SUBSTITUTION.test(sentence)) continue;
          assertSubstitutedByTheEngine(copy, sentence);
        }
      }
    }
  });

  test('no copy promises the engine to emit something about a user-controlled variable', () => {
    for (const copy of copies) {
      for (const statement of copy.statements) {
        if (statement.text.startsWith('```')) continue;
        for (const sentence of statement.sentences) {
          if (!speaksAboutClass(sentence)) continue;
          assertNoEmissionPromise(copy, sentence);
        }
      }
    }
  });
});

/** A statement that speaks about the class must say which variables it means. */
function assertNamesTheClass(copy: Document, statement: Statement): void {
  if (classClaim(statement).size === 0) {
    throw new Error(
      `${copy.file} speaks about the user-controlled variables without naming which variables it means`
    );
  }
}

/** A rule statement must claim that the variables are not spliced into the source. */
function assertNotSubstituted(copy: Document, statement: Statement): void {
  if (!hasNotSubstitutedClaim(statement)) {
    throw new Error(
      `${copy.file} does not say the user-controlled variables are not substituted into the source`
    );
  }
  for (const sentence of statement.sentences) {
    if (!speaksAboutClass(sentence)) continue;
    if (SUBSTITUTION.test(sentence) && !NEGATED_SUBSTITUTION.test(sentence)) {
      throw new Error(
        `${copy.file} says the user-controlled variables are substituted into the source: ${sentence}`
      );
    }
  }
}

/**
 * A copy that enumerates the class must enumerate the same names as the other copies, and
 * every name it names must be one the engine leaves out of a source.
 */
function assertSameClass(
  copy: Document,
  names: ReadonlySet<string>,
  expected: readonly string[]
): void {
  const listed = [...names].sort();
  if (listed.join(', ') !== expected.join(', ')) {
    throw new Error(
      `${copy.file} names ${listed.join(', ')} where the other copies name ${expected.join(', ')}`
    );
  }
  for (const name of names) {
    if (!USER_CONTROLLED.has(name)) {
      throw new Error(
        `${copy.file} calls ${name} user-controlled, which the engine does not leave out of a source`
      );
    }
  }
}

/** A copy that names examples of the class must name examples the class contains. */
function assertNamesExamplesOfTheClass(
  copy: Document,
  statement: Statement,
  expected: readonly string[]
): void {
  const listed = [...classClaim(statement)].sort();
  if (listed.join(', ') === expected.join(', ')) return;
  if (!namesExamples(statement)) {
    throw new Error(
      `${copy.file} names ${listed.join(', ')}, which is not the user-controlled class ${expected.join(', ')}`
    );
  }
  for (const name of listed) {
    if (!expected.includes(name)) {
      throw new Error(
        `${copy.file} names ${name}, which the user-controlled class does not contain`
      );
    }
  }
}

/** A variable a copy says is substituted into the source must be substituted by the engine. */
function assertSubstitutedByTheEngine(copy: Document, sentence: string): void {
  for (const name of variableNames(sentence)) {
    if (!substitutes(name, true)) {
      throw new Error(
        `${copy.file} says ${name} is substituted into the source, which the engine does not do`
      );
    }
  }
}

/** The engine emits nothing about a user-controlled variable: the warning is gone. */
function assertNoEmissionPromise(copy: Document, sentence: string): void {
  const promise = emissionPromise(sentence);
  if (promise === undefined) return;
  throw new Error(
    `${copy.file} promises the engine to ${promise} for a user-controlled variable: ${sentence}`
  );
}

/** The Markdown documents on the surfaces the rule ships through. */
function shippedDocuments(): Document[] {
  const documents: Document[] = [];
  for (const root of [DOCS_PAGES, BUNDLED_SKILL]) {
    for (const file of markdownFiles(root)) {
      const text = readFileSync(join(REPO, file), 'utf8');
      documents.push({ file, statements: statementsOf(text) });
    }
  }
  return documents;
}

/** The Markdown files under a root directory, read from the tree rather than from a list. */
function markdownFiles(root: string): string[] {
  const entries = readdirSync(join(REPO, root), { recursive: true });
  return entries
    .filter((entry): entry is string => typeof entry === 'string' && entry.endsWith('.md'))
    .map(entry => `${root}/${entry}`);
}

/** The statements of a document: its markdown items, each with the sentences in it. */
function statementsOf(text: string): Statement[] {
  return items(text).map(item => ({ text: item, sentences: sentences(item) }));
}

/** The markdown items of a document: paragraphs, list items, table rows and admonitions. */
function items(text: string): string[] {
  const found: string[][] = [];
  for (const chunk of text.split(/\n[ \t]*\n/)) {
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

/** The names the engine delivers but never splices into an exec node's source. */
function userControlledNames(): Set<string> {
  const names = new Set<string>();
  for (const name of EXEC_NODE_ENVIRONMENT_NAMES) {
    if (!substitutes(name, true) && substitutes(name, false)) names.add(name);
  }
  return names;
}

/** Whether the engine splices `$name` into a source. */
function substitutes(name: string, shellSafe: boolean): boolean {
  const options = {
    shellSafe,
    stateDir: 'state',
    typedArtifactsFile: 'artifacts.json',
    adoptedRunDir: 'adopted',
  };
  const { prompt } = substituteWorkflowVariables(
    `$${name}`,
    'run',
    'message',
    'artifacts',
    'main',
    'docs',
    'issue',
    '',
    '',
    '',
    options
  );
  return prompt !== `$${name}`;
}

/**
 * The variables a statement calls user-controlled: the ones it names in the sentences that
 * speak about the class. A statement that speaks about the class without naming a variable
 * says nothing about which variables it means.
 */
function classClaim(statement: Statement): Set<string> {
  const names = new Set<string>();
  for (const sentence of statement.sentences) {
    if (!speaksAboutClass(sentence)) continue;
    for (const name of variableNames(sentence)) names.add(name);
  }
  return names;
}

/** The variables a sentence names, in the spelling the copies write them in. */
function variableNames(sentence: string): string[] {
  return [...sentence.matchAll(/\$([A-Z_][A-Z0-9_]*)/g)].map(match => match[1]);
}

/** The user-controlled variables a text names, with or without the `$`. */
function classNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const name of USER_CONTROLLED) {
    if (new RegExp(`\\b${name}\\b`).test(text)) names.add(name);
  }
  return names;
}

/** Whether a text names a user-controlled variable, with or without the `$`. */
function namesClassVariable(text: string): boolean {
  return classNames(text).size > 0;
}

/** Whether a text speaks about the user-controlled variables, by name or by the phrase. */
function speaksAboutClass(text: string): boolean {
  return namesClassVariable(text) || /user-controlled/i.test(text);
}

/** The statements of a document that speak about the user-controlled variables. */
function statementsAboutClass(document: Document): Statement[] {
  return document.statements.filter(statement => speaksAboutClass(statement.text));
}

/** The exec node kinds a statement mentions. */
function kindsMentioned(statement: Statement): Set<ExecKind> {
  const kinds = new Set<ExecKind>();
  for (const kind of Object.keys(EXEC_KINDS) as ExecKind[]) {
    if (statement.text.includes(EXEC_KINDS[kind])) kinds.add(kind);
  }
  return kinds;
}

/** The environment variables a statement promises, by the form it promises them in. */
interface PromisedEnvironment {
  /** The names an accessor spells, in the forms the load-time scanner knows. */
  accessor: Set<string>;
  /** The names a quoted shell access reads. */
  shell: Set<string>;
  /** The names a sentence introduces as environment variables. */
  listed: Set<string>;
}

/** The environment variables a statement promises. */
function promisedEnvironment(statement: Statement): PromisedEnvironment {
  const accessor = new Set<string>();
  const shell = new Set<string>();
  const listed = new Set<string>();
  for (const { pattern, nameIndex } of ENVIRONMENT_READ_PATTERNS) {
    for (const match of statement.text.matchAll(pattern)) {
      const name = match[nameIndex];
      if (name !== undefined) accessor.add(name);
    }
  }
  for (const match of statement.text.matchAll(SHELL_ACCESS)) shell.add(match[1]);
  for (const sentence of statement.sentences) {
    if (!PROMISES_ENVIRONMENT.test(sentence)) continue;
    for (const match of sentence.matchAll(BACKTICKED_NAME)) listed.add(match[1]);
  }
  const delivered = (name: string): boolean => !name.startsWith(BINDING_PREFIX);
  return {
    accessor: new Set([...accessor].filter(delivered)),
    shell: new Set([...shell].filter(delivered)),
    listed: new Set([...listed].filter(delivered)),
  };
}

/** Every environment variable a statement promises, in any form. */
function allPromised(statement: Statement): Set<string> {
  const promised = promisedEnvironment(statement);
  return new Set([...promised.accessor, ...promised.shell, ...promised.listed]);
}

/**
 * Whether a statement tells a reader how an exec node of this kind receives a user-controlled
 * variable: a `bash:` node reads it from the shell, a `script:` node from an accessor.
 */
function promisesKind(statement: Statement, kind: ExecKind): boolean {
  const promised = promisedEnvironment(statement);
  const names = kind === 'bash' ? promised.shell : promised.accessor;
  return [...names].some(name => USER_CONTROLLED.has(name));
}

/**
 * Whether a statement claims that the variables are not spliced into the source. The claim
 * must be made about the class: a statement that says something else is not substituted does
 * not state the rule.
 */
function hasNotSubstitutedClaim(statement: Statement): boolean {
  return statement.sentences.some(
    sentence => speaksAboutClass(sentence) && NEGATED_SUBSTITUTION.test(sentence)
  );
}

/** Whether a statement enumerates the whole class rather than naming examples of it. */
function enumeratesClass(statement: Statement): boolean {
  return ENUMERATES_CLASS.test(statement.text) && !NAMES_EXAMPLES.test(statement.text);
}

/** Whether a statement names examples of the class rather than the whole of it. */
function namesExamples(statement: Statement): boolean {
  return NAMES_EXAMPLES.test(statement.text);
}

/**
 * The statements of a copy that state the rule: they name the user-controlled variables and
 * tell the reader how an exec node receives them.
 */
function ruleStatements(copy: Document): Statement[] {
  return copy.statements.filter(
    statement =>
      namesClassVariable(statement.text) &&
      (Object.keys(EXEC_KINDS) as ExecKind[]).some(
        kind => kindsMentioned(statement).has(kind) && promisesKind(statement, kind)
      )
  );
}

/** Whether a document states the rule, and so is a copy of it: it speaks about the
 * user-controlled variables in the environment channel an exec node delivers them in. */
function isCopy(document: Document): boolean {
  return document.statements.some(
    statement => namesClassVariable(statement.text) && speaksAboutEnvironment(statement)
  );
}

/** Whether a statement speaks about the environment channel: the environment variables the
 * engine delivers, or the accessor spellings that read them. */
function speaksAboutEnvironment(statement: Statement): boolean {
  if (PROMISES_ENVIRONMENT.test(statement.text)) return true;
  return ENVIRONMENT_READ_PATTERNS.some(({ pattern }) => statement.text.match(pattern) !== null);
}

/**
 * The promise a sentence makes about what the engine emits, or `undefined` when it makes
 * none. A sentence whose subject is the engine must make a claim the guard recognizes; a
 * verb it does not know fails closed rather than passing unnoticed.
 */
function emissionPromise(sentence: string): string | undefined {
  for (const match of sentence.matchAll(EMISSION)) {
    if (NEGATED_CLAIM.test(sentence.slice(0, match.index))) continue;
    return match[0];
  }
  if (!ENGINE_SUBJECT.test(sentence)) return undefined;
  if (NEGATED_SUBSTITUTION.test(sentence)) return undefined;
  if (PROMISES_ENVIRONMENT.test(sentence)) return undefined;
  return 'do something';
}
