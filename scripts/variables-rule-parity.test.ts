/**
 * The rule about user-controlled variables in an exec node ships as prose: the docs site's
 * pages and the bundled `archon-cli` skill, which `archon skill add` writes to every install.
 * This guard pins the documents that state the rule and holds each of them to the engine.
 *
 * The copy set is pinned in `COPY_PATHS`, not derived from a shape of prose: a document that
 * starts stating the rule and a document that stops stating it are both failures. Every copy
 * is a build input (`scripts/should-run-test-suite.ts`), so changing a copy runs this guard,
 * and the guard runs on every pull request as well (`scripts/validate.ts`, the
 * `variables-rule` check), so a copy that joins the set is caught on the pull request that
 * adds it.
 *
 * Every fact the guard holds a copy to belongs to the engine:
 * - `EXEC_NODE_ENVIRONMENT_NAMES` (`packages/workflows/src/exec-environment.ts`) is the bag an
 *   exec node delivers;
 * - `substituteWorkflowVariables` (`packages/workflows/src/workflow-variables.ts`) says which
 *   names the engine splices into a source, so the user-controlled class — the names it leaves
 *   out — comes from the engine, not from the copies that name it;
 * - `loopScopeTokens` (`packages/workflows/src/dag/loop-scope.ts`) is the engine's second
 *   substitution channel: a `loop_group` body's `bash:` source receives the loop reply,
 *   shell-quoted, so the guard asks the engine about that channel too;
 * - `inputEnvKey` (`packages/workflows/src/schemas/dag-node.ts`) owns the `with:` binding
 *   prefix, a channel of its own that the exec node's bag does not carry;
 * - `ENVIRONMENT_READ_PATTERNS` (`packages/workflows/src/exec-input-validation.ts`) owns the
 *   accessor spellings a copy may promise a variable in.
 *
 * A copy is read as the names it promises and the claims it makes about them. Every check asks
 * the engine what is true and holds the copy to that answer.
 *
 * The engine's own stance on a name it does not provide decides the scope of the promise
 * check. An exec node receives the engine's own bag, and the engine's scanner treats a name
 * outside that bag as a warning rather than a failure, because the project's configured
 * environment reaches the subprocess too (`exec-input-validation.ts`). The guard holds the
 * class's delivery — the names the engine itself delivers for the user-controlled variables —
 * to the engine's bag, and leaves the process environment to the engine's warning.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXEC_NODE_ENVIRONMENT_NAMES } from '../packages/workflows/src/exec-environment';
import { type LoopBodyScope, loopScopeTokens } from '../packages/workflows/src/dag/loop-scope';
import { ENVIRONMENT_READ_PATTERNS } from '../packages/workflows/src/exec-input-validation';
import { inputEnvKey } from '../packages/workflows/src/schemas/dag-node';
import { substituteWorkflowVariables } from '../packages/workflows/src/workflow-variables';
import { shouldRunTestSuite } from './should-run-test-suite';

const REPO = join(import.meta.dir, '..');

/** The surfaces the rule ships through: the docs site's pages and the bundled skill. */
const DOCS_PAGES = 'packages/docs-web/src/content/docs';
const BUNDLED_SKILL = '.claude/skills/archon-cli';

/**
 * The documents that state the rule. Pinned, so a document that starts stating the rule and a
 * document that stops stating it are both failures rather than a silent change of the set.
 */
const COPY_PATHS = [
  '.claude/skills/archon-cli/authoring/node-reference.md',
  '.claude/skills/archon-cli/authoring/variables.md',
  'packages/docs-web/src/content/docs/guides/script-nodes.md',
  'packages/docs-web/src/content/docs/reference/variables.md',
];

/** The `with:` binding channel's env prefix, read from the engine that owns it. */
const BINDING_PREFIX = inputEnvKey('');

/** The `with:` binding channel's template root (`$INPUTS.<name>`), from the same owner. */
const BINDING_ROOT = BINDING_PREFIX.replace(/_+$/, '');

/** The names the engine delivers but never splices into an exec node's source. */
const USER_CONTROLLED = userControlledNames();

/** A sentence that says the names it lists are environment variables. */
const PROMISES_ENVIRONMENT = /\b(?:environment variables?|env vars?)\b/i;

/** The exec node kinds a statement can talk about. */
const EXEC_KINDS = { bash: 'bash', script: 'script' } as const;
type ExecKind = keyof typeof EXEC_KINDS;

/** A backticked name, as the copies write an environment variable. */
const BACKTICKED_NAME = /`([A-Z][A-Z0-9_]*)`/g;

/**
 * A quoted shell access: the shell spelling a copy promises a value in. A bare `$NAME` is the
 * variable reference the engine leaves literal in a source, not a promise of the environment.
 */
const SHELL_ACCESS = /"\\?\$\{?([A-Z][A-Z0-9_]*)/g;

/** The words a copy uses to say that a value is spliced into the source. */
const SUBSTITUTION = /\b(?:substitut|splic|interpolat|embed|inlin|past)/i;

/**
 * A negation that governs the substitution word: the claim that the variables are not spliced
 * into the source. A negation that merely sits near the word says nothing about it.
 */
const NEGATED_SUBSTITUTION =
  /\b(?:not|never|no|neither|nor|without)\b[\s*_`"'-]{0,4}(?:[a-z]+-)?(?:substitut|splic|interpolat|embed|inlin|past)/i;

/** A sentence that names the source a value would be spliced into. */
const NAMES_SOURCE = /\b(?:source|executable code|code string)\b/i;

/**
 * The verbs a copy uses to promise that the engine emits something about a variable. Lower
 * case only: an environment variable named `LOG_DIR` is not a promise to log anything.
 */
const EMISSION =
  /\b(?:warn|notice|log|alert|flag|report|emit|print|inform|tell|remind|signal|announce|diagnos)[a-z]*/g;

/** A negation in front of a claim, which says the opposite of promising it. */
const NEGATED_CLAIM = /\b(?:not|never|no|without|instead of|rather than|no longer)\s*$/i;

/**
 * A negation anywhere in a sentence. The sentence then states the opposite of the claim it
 * carries, and the guard holds the copy to what the engine does rather than to the wording.
 */
const NEGATION = /\b(?:not|never|no|neither|nor|without|instead of|rather than|no longer)\b/i;

/** A sentence whose subject is the engine makes a claim about what the engine does. */
const ENGINE_SUBJECT = /^(?:archon\b|the engine\b|archon's\b)/i;

/** A statement that enumerates the class in a list, rather than naming examples of it. */
const ENUMERATES_CLASS = /\([^)]*\$[A-Z_]+[^)]*\)/;

/** A statement that names examples of the class rather than the whole of it. */
const NAMES_EXAMPLES = /\blike\s+`?\$/;

/**
 * An environment read the copy writes, in a shape the load-time scanner may or may not know:
 * `process.env.NAME`, `process.env["NAME"]`, `os.environ["NAME"]`, `os.environ.get("NAME")`
 * and `os.getenv("NAME")`. The scanner's own table owns the supported shapes.
 */
const ACCESSOR_SHAPE =
  /\b(?:process\.env|os\.\w*env\w*)\s*(?:\.\s*get\s*\(\s*["'][A-Za-z_][A-Za-z0-9_]*["'][^)]*|\(\s*["'][A-Za-z_][A-Za-z0-9_]*["'][^)]*|\[\s*["'][A-Za-z_][A-Za-z0-9_]*["']\s*\]|\.\s*[A-Za-z_][A-Za-z0-9_]*)/g;

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
  const copies = documents.filter(isCopy);

  test('the copy set is the pinned one', () => {
    const derived = copies.map(copy => copy.file).sort();
    const pinned = [...COPY_PATHS].sort();
    const added = derived.filter(file => !pinned.includes(file));
    const removed = pinned.filter(file => !derived.includes(file));
    if (added.length > 0 || removed.length > 0) {
      throw new Error(
        [
          added.length > 0
            ? `${added.join(', ')} states the user-controlled variable rule and is not in the pinned copy set`
            : '',
          removed.length > 0
            ? `${removed.join(', ')} is in the pinned copy set but no longer states the user-controlled variable rule`
            : '',
        ]
          .filter(line => line !== '')
          .join('; ')
      );
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

  test('every environment variable a copy promises for the class is one the exec node delivers', () => {
    for (const copy of copies) assertPromisedNamesAreDelivered(copy);
  });

  test('every variable a copy names is one the engine substitutes', () => {
    for (const copy of copies) assertNamedVariablesAreSubstituted(copy);
  });

  test('every name a copy calls user-controlled is one the engine leaves out of a source', () => {
    for (const copy of copies) assertClassNamesAreEngineOwned(copy);
  });

  test('every variable a copy calls user-controlled has an environment form it promises', () => {
    for (const copy of copies) assertClassNamesArePromised(copy);
  });

  test('the copies agree on the user-controlled class', () => {
    assertCopiesAgreeOnTheClass(copies);
  });

  test('every copy states that the variables are not substituted into the source', () => {
    for (const copy of copies) assertStatesTheSubstitutionRule(copy);
  });

  test('no copy says a variable is substituted into the source that the engine does not substitute', () => {
    for (const copy of copies) assertNoFalseSubstitutionClaim(copy);
  });

  test('no copy denies a splice the engine makes', () => {
    for (const copy of copies) assertNoFalseSubstitutionDenial(copy);
  });

  test('no copy promises the engine to emit something about a user-controlled variable', () => {
    for (const copy of copies) assertNoEmissionPromise(copy);
  });

  test('a copy that promises a script value names both runtimes', () => {
    for (const copy of copies) assertScriptPromiseNamesBothRuntimes(copy);
  });

  test('every environment read a copy documents is a spelling the scanner knows', () => {
    for (const copy of copies) assertDocumentedSpellingsAreKnown(copy);
  });

  test('the guard rejects a copy that promises a variable the exec node does not deliver', () => {
    const document: Document = {
      file: 'a synthetic copy',
      statements: statementsOf(
        'A `script:` node reads the user-controlled `$USER_MESSAGE` from the environment variable `process.env.NOT_A_REAL_VAR`.'
      ),
    };
    expect(() => assertPromisedNamesAreDelivered(document)).toThrow(/NOT_A_REAL_VAR/);
  });

  test('the guard rejects a copy that claims a variable is substituted when the engine does not', () => {
    const document: Document = {
      file: 'a synthetic copy',
      statements: statementsOf('A `script:` node substitutes `$LOG_DIR` into its source.'),
    };
    expect(() => assertNamedVariablesAreSubstituted(document)).toThrow(/LOG_DIR/);
  });

  test('the guard accepts a copy that reads a variable from the process environment', () => {
    const document: Document = {
      file: 'a synthetic copy',
      statements: statementsOf('A `bash:` node reads "$GITHUB_TOKEN" from the environment.'),
    };
    expect(() => assertNamedVariablesAreSubstituted(document)).not.toThrow();
  });
});

/**
 * Every environment variable a copy promises for the class must be one the exec node
 * delivers. The engine's own bag is the authority for the class: the engine delivers
 * exactly these names for the user-controlled variables, and a copy that promises another
 * one sends a reader after a value the engine never sets.
 */
function assertPromisedNamesAreDelivered(document: Document): void {
  for (const statement of classStatements(document)) {
    for (const name of promisedNames(statement)) {
      if (EXEC_NODE_ENVIRONMENT_NAMES.has(name)) continue;
      if (isBindingName(name)) continue;
      throw new Error(
        `${document.file} promises the environment variable ${name}, which the exec node does not deliver`
      );
    }
  }
}

/** Every variable a copy names must be one the engine substitutes, or a `with:` binding. */
function assertNamedVariablesAreSubstituted(document: Document): void {
  for (const statement of document.statements) {
    for (const name of namedVariables(statement.text)) {
      if (isBindingName(name)) continue;
      // A name the copy shows being read from the environment is not a substitution claim:
      // the engine passes the project's configured environment to the subprocess, so the
      // engine's own scanner warns about such a name rather than failing it.
      if (readsFromEnvironment(statement, name)) continue;
      if (substitutes(name, false)) continue;
      throw new Error(
        `${document.file} names the variable $${name}, which the engine does not substitute`
      );
    }
  }
}

/** Every name a copy calls user-controlled must be one the engine leaves out of a source. */
function assertClassNamesAreEngineOwned(document: Document): void {
  for (const statement of ruleStatements(document)) {
    for (const name of classClaim(statement)) {
      if (USER_CONTROLLED.has(name)) continue;
      throw new Error(
        `${document.file} calls ${name} user-controlled, which the engine does not leave out of a source`
      );
    }
  }
}

/** Every name a copy calls user-controlled must also be one it promises as a variable. */
function assertClassNamesArePromised(document: Document): void {
  for (const statement of ruleStatements(document)) {
    const promised = promisedNames(statement);
    for (const name of classClaim(statement)) {
      if (promised.has(name)) continue;
      throw new Error(
        `${document.file} calls ${name} user-controlled but promises no ${name} environment variable`
      );
    }
  }
}

/** The copies must name the same user-controlled class, and the engine owns its membership. */
function assertCopiesAgreeOnTheClass(copies: readonly Document[]): void {
  const enumerations = copies.flatMap(copy =>
    ruleStatements(copy)
      .filter(enumeratesClass)
      .map(statement => ({ copy, names: classClaim(statement) }))
  );
  if (enumerations.length === 0) {
    throw new Error('No copy names which variables are user-controlled');
  }
  const [first, ...rest] = enumerations;
  for (const { copy, names } of rest) {
    const listed = [...names].sort().join(', ');
    const expected = [...first.names].sort().join(', ');
    if (listed !== expected) {
      throw new Error(`${copy.file} names ${listed} where ${first.copy.file} names ${expected}`);
    }
  }
}

/** A copy must state that the user-controlled variables are not spliced into the source. */
function assertStatesTheSubstitutionRule(document: Document): void {
  const states = ruleStatements(document).some(statement =>
    statement.sentences.some(
      sentence => speaksAboutClass(sentence) && NEGATED_SUBSTITUTION.test(sentence)
    )
  );
  if (!states) {
    throw new Error(
      `${document.file} does not say the user-controlled variables are not substituted into the source`
    );
  }
}

/**
 * A copy may say that a value is spliced into the source only when the engine splices it. The
 * engine has two channels, and the guard asks about both: the workflow variables a shell-safe
 * substitution leaves out, and the loop scope that splices a reply into a `loop_group` body's
 * `bash:` source.
 */
function assertNoFalseSubstitutionClaim(document: Document): void {
  for (const sentence of substitutionClaims(document)) {
    const named = classNames(sentence);
    for (const name of named) {
      if (splicesIntoSource(name, sentence)) continue;
      throw new Error(
        `${document.file} says ${name} is substituted into the source, which the engine does not do: ${sentence}`
      );
    }
    if (named.size === 0) {
      throw new Error(
        `${document.file} says the user-controlled variables are substituted into the source, which the engine does not do: ${sentence}`
      );
    }
  }
}

/**
 * A copy that denies a splice the engine makes is wrong for one surface. The engine splices
 * the loop reply into a `loop_group` body's `bash:` source, shell-quoted, so a copy that says
 * the user-controlled variables are never spliced has to name that exception.
 */
function assertNoFalseSubstitutionDenial(document: Document): void {
  for (const sentence of substitutionDenials(document)) {
    for (const kind of surfacesOf(sentence)) {
      const denied = deniedSplices(sentence, kind);
      if (denied.length === 0) continue;
      if (denied.every(name => statesSplice(document, name, kind))) continue;
      throw new Error(
        `${document.file} denies the splice of ${denied.join(', ')} into a ${kind} source, which the engine does do: ${sentence}`
      );
    }
  }
}

/** The sentences of a copy that claim the class is spliced into the source. */
function substitutionClaims(document: Document): string[] {
  return ruleStatements(document)
    .flatMap(statement => statement.sentences)
    .filter(
      sentence =>
        speaksAboutClass(sentence) &&
        !NEGATION.test(sentence) &&
        (SUBSTITUTION.test(sentence) || NAMES_SOURCE.test(sentence))
    );
}

/** The sentences of a copy that deny the class is spliced into the source. */
function substitutionDenials(document: Document): string[] {
  return ruleStatements(document)
    .flatMap(statement => statement.sentences)
    .filter(sentence => speaksAboutClass(sentence) && NEGATED_SUBSTITUTION.test(sentence));
}

/** The class names a denial covers that the engine splices into a source of a kind. */
function deniedSplices(sentence: string, kind: ExecKind): string[] {
  return [...classNames(sentence)].filter(name => engineSplices(name, kind));
}

/** Whether a copy states that the engine splices a variable into a source of a kind. */
function statesSplice(document: Document, name: string, kind: ExecKind): boolean {
  return document.statements.some(statement =>
    statement.sentences.some(
      sentence =>
        speaksAboutClass(sentence) &&
        !NEGATION.test(sentence) &&
        SUBSTITUTION.test(sentence) &&
        classNames(sentence).has(name) &&
        surfacesOf(sentence).has(kind)
    )
  );
}

/** The engine emits nothing about a user-controlled variable: the warning is gone. */
function assertNoEmissionPromise(document: Document): void {
  for (const statement of document.statements) {
    for (const sentence of statement.sentences) {
      if (!speaksAboutClass(sentence)) continue;
      const promise = emissionPromise(sentence);
      if (promise === undefined) continue;
      throw new Error(
        `${document.file} promises the engine to ${promise} for a user-controlled variable: ${sentence}`
      );
    }
  }
}

/**
 * A copy that tells a reader how to read a value in a `script:` node must name the accessor of
 * every runtime a `script:` node can dispatch under.
 */
function assertScriptPromiseNamesBothRuntimes(document: Document): void {
  for (const statement of ruleStatements(document)) {
    if (!mentionsKind(statement, 'script')) continue;
    const promised = promisedEnvironment(statement);
    if (promised.accessor.size === 0) continue;
    for (const runtime of ['bun', 'uv']) {
      const names = promised.accessor.get(runtime);
      if (names === undefined || names.size === 0) {
        throw new Error(
          `${document.file} promises a script value without naming the ${runtime} accessor`
        );
      }
    }
  }
}

/** Every environment read a copy documents must be a spelling the load-time scanner knows. */
function assertDocumentedSpellingsAreKnown(document: Document): void {
  for (const statement of document.statements) {
    for (const match of statement.text.matchAll(ACCESSOR_SHAPE)) {
      const expression = match[0];
      if (scannerKnows(expression)) continue;
      throw new Error(
        `${document.file} documents the environment read ${expression}, which the load-time scanner does not know`
      );
    }
  }
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

/**
 * The markdown items of a document: paragraphs, list items, table rows and admonitions. A
 * fenced code block is not prose and is not read.
 */
function items(text: string): string[] {
  const found: string[][] = [];
  let current: string[] | undefined;
  let inFence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      current = undefined;
      continue;
    }
    if (inFence) continue;
    if (line.trim() === '') {
      current = undefined;
      continue;
    }
    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line) || /^\s*\|/.test(line) || current === undefined) {
      current = [];
      found.push(current);
    }
    current.push(line);
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

/**
 * Whether a copy reads a name from the environment rather than claiming the engine splices
 * it into a source. The engine's own scanner treats such a name as a warning, because the
 * project's configured environment reaches the subprocess too.
 */
function readsFromEnvironment(statement: Statement, name: string): boolean {
  const promised = promisedEnvironment(statement);
  if (promised.shell.has(name)) return true;
  for (const runtimeNames of promised.accessor.values()) {
    if (runtimeNames.has(name)) return true;
  }
  return false;
}

/** Whether the engine splices `$name` into a source. */
function substitutes(name: string, shellSafe: boolean): boolean {
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
    {
      shellSafe,
      stateDir: 'state',
      typedArtifactsFile: 'artifacts.json',
      adoptedRunDir: 'adopted',
    }
  );
  return prompt !== `$${name}`;
}

/**
 * Whether the engine splices `$name` into a source. The engine has two channels: the workflow
 * variables a shell-safe substitution leaves out, and the loop scope that splices a reply into
 * a `loop_group` body's source. The loop scope quotes the reply for a `bash:` source and
 * leaves it literal for a `script:` one, so the answer depends on the surface.
 */
function splicesIntoSource(name: string, sentence: string): boolean {
  const kinds = surfacesOf(sentence);
  if (kinds.size === 0) return engineSplices(name, 'bash') || engineSplices(name, 'script');
  return [...kinds].every(kind => engineSplices(name, kind));
}

/** Whether the engine splices `$name` into a source of a kind. */
function engineSplices(name: string, kind: ExecKind): boolean {
  const scope: LoopBodyScope = { loopPrevOutputs: undefined, loopUserInput: 'the reply' };
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
    {
      shellSafe: true,
      stateDir: 'state',
      typedArtifactsFile: 'artifacts.json',
      adoptedRunDir: 'adopted',
      references: {
        before: loopScopeTokens(scope, kind === 'bash' ? 'shell' : 'script'),
        after: [],
      },
    }
  );
  return prompt !== `$${name}`;
}

/** The exec node kinds a sentence talks about. */
function surfacesOf(sentence: string): Set<ExecKind> {
  const kinds = new Set<ExecKind>();
  for (const kind of Object.keys(EXEC_KINDS) as ExecKind[]) {
    if (new RegExp(`\\b${kind}s?\\b`, 'i').test(sentence)) kinds.add(kind);
  }
  return kinds;
}

/** Whether a name belongs to the `with:` binding channel, which the exec node's bag lacks. */
function isBindingName(name: string): boolean {
  return name.startsWith(BINDING_PREFIX) || name === BINDING_ROOT;
}

/**
 * The variables a statement calls user-controlled: the ones it names in the sentences that
 * speak about the class.
 */
function classClaim(statement: Statement): Set<string> {
  const names = new Set<string>();
  for (const sentence of statement.sentences) {
    if (!speaksAboutClass(sentence)) continue;
    for (const name of namedVariables(sentence)) names.add(name);
  }
  return names;
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

/**
 * The variables a text names as `$NAME`. A name that opens a structured reference
 * (`$LOOP_PREV.<nodeId>.output`, `$INPUTS.<name>`) is not a variable of its own.
 */
function namedVariables(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(/\$([A-Z_][A-Z0-9_]*)/g)) {
    const after = text.slice(match.index + match[0].length).replace(/^`+/, '');
    if (after.startsWith('.')) continue;
    names.push(match[1]);
  }
  return names;
}

/** Whether a statement talks about one of the exec node kinds. */
function mentionsKind(statement: Statement, kind: ExecKind): boolean {
  return new RegExp(`\\b${kind}s?\\b`, 'i').test(statement.text);
}

/** Whether a text talks about the environment channel an exec node delivers values in. */
function speaksAboutEnvironment(text: string): boolean {
  return PROMISES_ENVIRONMENT.test(text);
}

/**
 * The statements of a document that speak about the user-controlled class. The class's
 * delivery is the engine's own bag, so these are the statements whose promises the guard
 * holds to it.
 */
function classStatements(document: Document): Statement[] {
  return document.statements.filter(statement => speaksAboutClass(statement.text));
}

/**
 * The statements of a document that state the rule: they talk about an exec node kind, they
 * talk about the environment channel it delivers the user-controlled values in, and they show
 * how a reader reads such a value. A statement that names no variable is still read, so a
 * promise it carries cannot escape the guard.
 */
function ruleStatements(document: Document): Statement[] {
  return document.statements.filter(
    statement =>
      speaksAboutEnvironment(statement.text) &&
      (mentionsKind(statement, 'bash') || mentionsKind(statement, 'script')) &&
      writesDeliveryForm(statement)
  );
}

/**
 * Whether a statement shows how a reader reads a value the engine delivers. The `with:`
 * binding channel is a channel of its own, and a statement that only speaks about it says
 * nothing about the bag an exec node delivers.
 */
function writesDeliveryForm(statement: Statement): boolean {
  const promised = promisedEnvironment(statement);
  const delivered = [...promised.accessor.values()].flatMap(names => [...names]);
  const names = [...delivered, ...promised.shell];
  return names.some(name => !isBindingName(name)) && names.length > 0;
}

/** Whether a document states the rule, and so is a copy of it. */
function isCopy(document: Document): boolean {
  return ruleStatements(document).length > 0;
}

/** The environment variables a statement promises, by the form it promises them in. */
interface PromisedEnvironment {
  /** The names an accessor spells, by the runtime the spelling belongs to. */
  accessor: Map<string, Set<string>>;
  /** The names a quoted shell access reads. */
  shell: Set<string>;
  /** The names a statement names in a delivery form it writes. */
  listed: Set<string>;
}

/** The environment variables a statement promises. */
function promisedEnvironment(statement: Statement): PromisedEnvironment {
  const accessor = new Map<string, Set<string>>();
  const shell = new Set<string>();
  const listed = new Set<string>();
  for (const { pattern, nameIndex, runtime } of ENVIRONMENT_READ_PATTERNS) {
    for (const match of statement.text.matchAll(pattern)) {
      const name = match[nameIndex];
      if (name === undefined) continue;
      const names = accessor.get(runtime) ?? new Set<string>();
      names.add(name);
      accessor.set(runtime, names);
    }
  }
  for (const match of statement.text.matchAll(SHELL_ACCESS)) shell.add(match[1]);
  for (const match of statement.text.matchAll(BACKTICKED_NAME)) listed.add(match[1]);
  return { accessor, shell, listed };
}

/** Every environment variable a statement promises, in any form. */
function promisedNames(statement: Statement): Set<string> {
  const promised = promisedEnvironment(statement);
  const names = new Set<string>(promised.shell);
  for (const runtimeNames of promised.accessor.values()) {
    for (const name of runtimeNames) names.add(name);
  }
  for (const name of promised.listed) names.add(name);
  return names;
}

/**
 * Whether the load-time scanner knows an environment read. The scanner's table owns the
 * supported spellings; a copy that documents another one tells a reader something the engine
 * does not do.
 */
function scannerKnows(expression: string): boolean {
  return ENVIRONMENT_READ_PATTERNS.some(({ pattern }) => {
    const matcher = new RegExp(pattern.source, pattern.flags.replace('g', ''));
    return matcher.test(expression);
  });
}

/**
 * The promise a sentence makes about what the engine emits, or `undefined` when it makes
 * none. A sentence whose subject is the engine must make a claim the guard recognizes; a
 * verb it does not know fails closed rather than passing unnoticed.
 */
function emissionPromise(sentence: string): string | undefined {
  for (const match of sentence.matchAll(EMISSION)) {
    if (NEGATED_CLAIM.test(sentence.slice(0, match.index))) continue;
    if (!ENGINE_SUBJECT.test(sentence)) continue;
    return match[0];
  }
  if (!ENGINE_SUBJECT.test(sentence)) return undefined;
  if (NEGATION.test(sentence)) return undefined;
  if (NEGATED_SUBSTITUTION.test(sentence)) return undefined;
  if (PROMISES_ENVIRONMENT.test(sentence)) return undefined;
  return 'do something';
}

/** Whether a statement enumerates the whole class rather than naming examples of it. */
function enumeratesClass(statement: Statement): boolean {
  return ENUMERATES_CLASS.test(statement.text) && !NAMES_EXAMPLES.test(statement.text);
}
