/**
 * The rule about user-controlled variables in an exec node ships as prose: the docs site's
 * pages and the bundled `archon-cli` skill, which `archon skill add` writes to every install.
 * This guard pins rule statements for review and checks their names against the engine.
 *
 * The copy set is pinned in `COPY_PATHS`, so a document that starts stating the rule and a
 * document that stops stating it are both failures rather than a silent change of the set. A
 * document joins the set when it states the rule about a `bash:` or `script:` node. The guard
 * runs in the `static` CI job (`scripts/validate.ts`, the `variables-rule` check), which runs
 * on every push to `main` and `dev` and on every pull request that is not a draft, so a copy
 * that joins the set is caught by that check.
 *
 * Name and accessor checks derive their vocabulary from the engine:
 * - `EXEC_NODE_ENVIRONMENT_NAMES` (`packages/workflows/src/exec-environment.ts`) is the bag an
 *   exec node delivers, and the authority a copy's class delivery is held to: the project's
 *   configured environment reaches the same subprocess, but it is not the class's delivery;
 * - `substituteWorkflowVariables` (`packages/workflows/src/workflow-variables.ts`) says which
 *   names the engine splices into a source, so the user-controlled class — the names it leaves
 *   out — comes from the engine, not from the copies that name it;
 * - `CONTEXT_VAR_PATTERN_STR` (the same module) is the engine's one context variable with
 *   three spellings, so a copy may name any of them for that member of the class;
 * - `inputEnvKey` (`packages/workflows/src/schemas/dag-node.ts`) owns the `with:` binding
 *   prefix, a channel of its own that the exec node's bag does not carry;
 * - `execNodeSchema` (the same module) owns the runtimes a `script:` node dispatches under;
 * - `ENVIRONMENT_READ_PATTERNS` (`packages/workflows/src/exec-input-validation.ts`) owns the
 *   accessor spellings a copy may document, and the runtime each spelling belongs to.
 *
 * `variables-rule-statements.json` pins the text of rule items naming the class and an exec
 * kind, with whitespace normalized. Changes require reviewing and updating that fixture; the
 * guard does not infer whether prose affirms or denies substitution. Name/accessor checks
 * recognize the forms used by the shipped copies, not arbitrary prose. Environment names are
 * checked in sentences naming the user-controlled class, so other sections can document project
 * configuration and credentials outside the engine's own bag.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { EXEC_NODE_ENVIRONMENT_NAMES } from '../packages/workflows/src/exec-environment';
import { ENVIRONMENT_READ_PATTERNS } from '../packages/workflows/src/exec-input-validation';
import { execNodeSchema, inputEnvKey } from '../packages/workflows/src/schemas/dag-node';
import {
  CONTEXT_VAR_PATTERN_STR,
  substituteWorkflowVariables,
} from '../packages/workflows/src/workflow-variables';
import pinnedStatements from './variables-rule-statements.json';

const REPO = join(import.meta.dir, '..');

/** The surfaces the rule ships through: the docs site's pages and the bundled skill. */
const DOCS_PAGES = 'packages/docs-web/src/content/docs';
const BUNDLED_SKILL = '.claude/skills/archon-cli';

/** The extensions a page of the docs site or of the bundled skill ships in. */
const PAGE_EXTENSIONS = ['.md', '.mdx'];

/**
 * The documents that state the rule. Pinned, so a document that starts stating the rule and a
 * document that stops stating it are both failures rather than a silent change of the set.
 */
const COPY_PATHS = Object.keys(pinnedStatements);

/** The `with:` binding channel's env prefix, read from the engine that owns it. */
const BINDING_PREFIX = inputEnvKey('');

/** The `with:` binding channel's template root (`$INPUTS.<name>`), from the same owner. */
const BINDING_ROOT = BINDING_PREFIX.replace(/_+$/, '');

/** The names the engine delivers but never splices into an exec node's source. */
const USER_CONTROLLED = userControlledNames();

/**
 * The engine's context variable, which has three spellings for one value. The engine
 * resolves all of them to the same value (`CONTEXT_VAR_PATTERN_STR`), so a copy may name
 * any one of them for that member of the class.
 */
const CONTEXT_FAMILY = contextFamilyNames();

/** The runtimes a `script:` node dispatches under, from the schema that owns them. */
const SCRIPT_RUNTIMES = execNodeSchema.shape.runtime.exclude(['sh']).options;

/** A backticked name, as the copies write an environment variable. */
const BACKTICKED_NAME = /`([A-Z][A-Z0-9_]*)`/g;

/**
 * A quoted shell access: the shell spelling a copy reads a delivered value in. A bare `$NAME`
 * is the template reference the engine leaves literal in a source, not a promise of the
 * environment.
 */
const SHELL_ACCESS = /"\\?\$\{?([A-Z][A-Z0-9_]*)/g;

/** A template reference, `$NAME`. */
const TEMPLATE_REFERENCE = /\$([A-Z_][A-Z0-9_]*)/g;

/**
 * A structured reference continues a name with a dot and an identifier — `$LOOP_PREV.<id>.output`,
 * `$INPUTS.<name>` — and names no variable of its own. A dot that ends a sentence does not.
 */
const STRUCTURED_REFERENCE = /^\.(?:[A-Za-z_<])/;

/**
 * The phrase the copies use for the class. A sentence that uses it is the one that calls the
 * names it lists user-controlled.
 */
const NAMES_THE_CLASS = /user-controlled/i;

/**
 * The environment reads a copy may document: the spellings a reader writes. The scanner's own
 * table owns the answer; this list only says which spellings to ask about.
 */
const ACCESSOR_SHAPE =
  /\b(?:process\.env|os\.\w*env\w*)\s*(?:\.\s*get\s*\(\s*["'][A-Za-z_][A-Za-z0-9_]*["'][^)]*|\(\s*["'][A-Za-z_][A-Za-z0-9_]*["'][^)]*|\[\s*["'][A-Za-z_][A-Za-z0-9_]*["']\s*\]|\.\s*[A-Za-z_][A-Za-z0-9_]*)/g;

/** The exec node kinds a sentence can talk about. */
const EXEC_KINDS = { bash: 'bash', script: 'script' } as const;
type ExecKind = keyof typeof EXEC_KINDS;

/** A paragraph, list item, table row or admonition of a document. */
interface Item {
  text: string;
  sentences: string[];
}

/** A document the rule ships in. */
interface Document {
  file: string;
  items: Item[];
}

describe('the user-controlled variable rule', () => {
  const trackTempRoot = trackTempRoots();
  const documents = shippedDocuments();
  const copies = copiesOf(documents);

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

  test('every environment variable a copy promises for the class is one the exec node delivers', () => {
    for (const copy of copies) assertPromisedNamesAreDelivered(copy);
  });

  test('the copies name the user-controlled class the engine delivers', () => {
    assertCopiesNameTheEngineClass(copies);
  });

  test('the pinned rule statements have not changed without review', () => {
    for (const copy of copies) assertPinnedRuleStatements(copy);
  });

  test('the guard rejects a contradictory script substitution statement in every copy', () => {
    for (const copy of copies) {
      const mutated = {
        ...copy,
        items: [
          ...copy.items,
          ...itemsOf('In a `script:` node, `$ARGUMENTS` is embedded in the script source.'),
        ],
      };
      expect(() => assertPinnedRuleStatements(mutated)).toThrow();
    }
  });

  test('the guard rejects editing or removing a pinned rule item in every copy', () => {
    for (const copy of copies) {
      const target = copy.items.find(item => item.text.includes('loop scope splices'));
      expect(target).toBeDefined();
      const edited = {
        ...copy,
        items: copy.items.map(item =>
          item === target ? { ...item, text: `${item.text} Changed rule.` } : item
        ),
      };
      const removed = { ...copy, items: copy.items.filter(item => item !== target) };
      expect(() => assertPinnedRuleStatements(edited)).toThrow();
      expect(() => assertPinnedRuleStatements(removed)).toThrow();
    }
  });

  test('the pinned statements allow whitespace-only changes in every copy', () => {
    for (const copy of copies) {
      const reflowed = {
        ...copy,
        items: copy.items.map(item => ({ ...item, text: item.text.replace(/\s+/g, '\n') })),
      };
      expect(() => assertPinnedRuleStatements(reflowed)).not.toThrow();
    }
  });

  test('every name a copy calls user-controlled is one the engine leaves out of a source', () => {
    for (const copy of copies) assertClassNamesAreEngineOwned(copy);
  });

  test('every template variable a copy names is one the engine substitutes', () => {
    for (const copy of copies) assertNamedVariablesAreSubstituted(copy);
  });

  test('a copy that promises a script value names both runtimes', () => {
    for (const copy of copies) assertScriptPromiseNamesBothRuntimes(copy);
  });

  test('every environment read a copy documents is a spelling the scanner knows', () => {
    for (const copy of copies) assertDocumentedSpellingsAreKnown(copy);
  });

  test.each(['process.env.ARGUMENTS', "os.environ['ARGUMENTS']"])(
    'every copy rejects %s as a bash environment accessor',
    accessor => {
      for (const copy of copies) {
        const text = copy.items.map(item => item.text).join('\n\n');
        const mutated = text.replaceAll('"$ARGUMENTS"', accessor);
        expect(mutated).not.toBe(text);
        expect(() =>
          assertDocumentedSpellingsAreKnown({ ...copy, items: itemsOf(mutated) })
        ).toThrow(/runtime/);
      }
    }
  );

  test('the guard rejects a copy that promises a variable the exec node does not deliver', () => {
    const document = documentOf(
      'A `script:` node reads the user-controlled `$USER_MESSAGE` from the environment variable `process.env.NOT_A_REAL_VAR`.'
    );
    expect(() => assertPromisedNamesAreDelivered(document)).toThrow(/NOT_A_REAL_VAR/);
  });

  test('the guard rejects a promise the class statement does not belong to', () => {
    const document = documentOf(
      'The user-controlled variables arrive as environment variables: `NOT_A_REAL_VAR`.'
    );
    expect(() => assertPromisedNamesAreDelivered(document)).toThrow(/NOT_A_REAL_VAR/);
  });

  test('the guard rejects copies that do not name the whole class', () => {
    const document = documentOf(
      'The user-controlled variables are `$USER_MESSAGE`, `$ARGUMENTS`, `$LOOP_USER_INPUT`, `$LOOP_PREV_OUTPUT` and `$CONTEXT`.'
    );
    expect(() => assertCopiesNameTheEngineClass([document])).toThrow(/REJECTION_REASON/);
  });

  test('the guard rejects a name a copy calls user-controlled that the engine does not leave out', () => {
    const document = documentOf(
      'The user-controlled variables are `$USER_MESSAGE` and `$LOG_DIR`.'
    );
    expect(() => assertClassNamesAreEngineOwned(document)).toThrow(/LOG_DIR/);
  });

  test('the guard accepts a copy that reads a variable from the process environment', () => {
    const document = documentOf('A `bash:` node reads "$GITHUB_TOKEN" from the environment.');
    expect(() => assertNamedVariablesAreSubstituted(document)).not.toThrow();
  });

  test('a document that states the rule in prose joins the copy set', () => {
    const document = documentOf(
      'User-controlled workflow variables are passed to `bash:` nodes as environment variables, not spliced into the shell command.'
    );
    expect(copiesOf([document]).map(copy => copy.file)).toEqual(['a synthetic copy']);
  });

  test('the guard reads every Markdown extension the surfaces ship in', () => {
    const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'variables-rule-pages-')));
    writeFileSync(join(root, 'page.md'), '# page\n');
    writeFileSync(join(root, 'page.mdx'), '# page\n');
    writeFileSync(join(root, 'notes.txt'), 'not a page\n');
    const read = pageFiles(root)
      .map(file => basename(file))
      .sort();
    expect(read).toEqual(['page.md', 'page.mdx']);
  });
});

/**
 * Every environment variable a copy promises for the class must be one the exec node
 * delivers. The engine's own bag is the authority for the class: the engine delivers
 * exactly these names for the user-controlled variables, and a copy that promises another
 * one sends a reader after a value the engine never sets.
 */
function assertPromisedNamesAreDelivered(document: Document): void {
  for (const sentence of classSentences(document)) {
    for (const name of promisedNames(sentence)) {
      if (EXEC_NODE_ENVIRONMENT_NAMES.has(name)) continue;
      if (isBindingName(name)) continue;
      throw new Error(
        `${document.file} promises the environment variable ${name} for the user-controlled variables, which the exec node's environment bag does not carry`
      );
    }
  }
}

/**
 * The copies must name the engine's class. The engine owns the class's membership, so the
 * copies must name every member the engine leaves out of a source. The context variable has
 * three spellings for one value, so one spelling is enough.
 */
function assertCopiesNameTheEngineClass(copies: readonly Document[]): void {
  const named = new Set<string>();
  for (const copy of copies) {
    for (const name of classNames(copy.items.map(item => item.text).join('\n'))) named.add(name);
  }
  const missing = [...USER_CONTROLLED].filter(
    name => !CONTEXT_FAMILY.has(name) && !named.has(name)
  );
  if (missing.length > 0) {
    throw new Error(
      `the copies do not name ${missing.join(', ')}, which the engine leaves out of a source`
    );
  }
  if (![...named].some(name => CONTEXT_FAMILY.has(name))) {
    throw new Error(
      'the copies do not name a context variable, which the engine leaves out of a source'
    );
  }
}

/** Pin rule prose for review rather than attempting to classify its meaning. */
function ruleStatements(document: Document): string[] {
  return document.items
    .filter(item => speaksAboutClass(item.text) && surfacesOf(item.text).size > 0)
    .map(item => item.text.replace(/\s+/g, ' ').trim());
}

function assertPinnedRuleStatements(document: Document): void {
  const pinned = Object.entries(pinnedStatements).find(([file]) => file === document.file);
  if (pinned === undefined) throw new Error(`No pinned rule statements for ${document.file}`);
  expect(ruleStatements(document)).toEqual(pinned[1]);
}

/** Every name a copy calls user-controlled must be one the engine leaves out of a source. */
function assertClassNamesAreEngineOwned(document: Document): void {
  for (const sentence of document.items.flatMap(item => item.sentences)) {
    if (!NAMES_THE_CLASS.test(sentence)) continue;
    for (const name of templateReferences(sentence)) {
      if (USER_CONTROLLED.has(name)) continue;
      throw new Error(
        `${document.file} calls ${name} user-controlled, which the engine does not leave out of a source`
      );
    }
  }
}

/** Every template variable a copy names must be one the engine substitutes, or a binding. */
function assertNamedVariablesAreSubstituted(document: Document): void {
  for (const sentence of document.items.flatMap(item => item.sentences)) {
    for (const name of templateReferences(sentence)) {
      if (isBindingName(name)) continue;
      // A name the copy shows being read from the environment is not a substitution claim:
      // the engine passes the project's configured environment to the subprocess, so the
      // engine's own scanner warns about such a name rather than failing it.
      if (readsFromEnvironment(sentence, name)) continue;
      if (substitutes(name, false)) continue;
      throw new Error(
        `${document.file} names the variable $${name}, which the engine does not substitute`
      );
    }
  }
}

/**
 * A copy that tells a reader how to read a user-controlled value in a `script:` node must name
 * the accessor of every runtime a `script:` node can dispatch under.
 */
function assertScriptPromiseNamesBothRuntimes(document: Document): void {
  for (const item of document.items) {
    if (classNames(item.text).size === 0) continue;
    if (!mentionsKind(item.text, 'script')) continue;
    const promised = promisedEnvironment(item.text);
    const delivered = SCRIPT_RUNTIMES.map(runtime => classValuesPromisedIn(runtime, promised));
    if (delivered.every(names => names.length === 0)) continue;
    for (const [index, runtime] of SCRIPT_RUNTIMES.entries()) {
      if ((delivered[index] ?? []).length > 0) continue;
      throw new Error(
        `${document.file} promises a script value without naming the ${runtime} accessor`
      );
    }
  }
}

/** The user-controlled values a text promises for a runtime, through that runtime's accessor. */
function classValuesPromisedIn(runtime: string, promised: PromisedEnvironment): string[] {
  return [...(promised.accessor.get(runtime) ?? [])].filter(name => USER_CONTROLLED.has(name));
}

/**
 * Every environment read a copy promises must be a spelling the load-time scanner knows. A
 * read of a user-controlled value must be one the scanner knows for the runtime the copy
 * talks about: the engine's scanner reads a `bash:` body under `sh` and a `script:` body
 * under a script runtime, and a copy that promises a spelling the scanner never sees tells a
 * reader something the engine does not do.
 */
function assertDocumentedSpellingsAreKnown(document: Document): void {
  for (const sentence of document.items.flatMap(item => item.sentences)) {
    assertClassReadsAreKnown(document, sentence);
    assertSpellingsAreKnown(document, sentence);
  }
}

/**
 * A read of a user-controlled value must be a spelling the scanner knows for the runtime the
 * copy names: the engine's scanner reads a `bash:` body under `sh` and a `script:` body under
 * a script runtime.
 */
function assertClassReadsAreKnown(document: Document, sentence: string): void {
  const runtimes = runtimesInPlay(sentence);
  for (const { pattern, nameIndex, runtime } of ENVIRONMENT_READ_PATTERNS) {
    for (const match of sentence.matchAll(pattern)) {
      const name = match[nameIndex];
      if (name === undefined || !USER_CONTROLLED.has(name)) continue;
      if (runtimes.size === 0 || runtimes.has(runtime)) continue;
      throw new Error(
        `${document.file} documents the environment read ${match[0]}, which the load-time scanner does not know for the runtime it names`
      );
    }
  }
}

/** Every environment read a copy documents must be a spelling the scanner knows. */
function assertSpellingsAreKnown(document: Document, sentence: string): void {
  for (const match of sentence.matchAll(ACCESSOR_SHAPE)) {
    if (scannerKnows(match[0], new Set())) continue;
    throw new Error(
      `${document.file} documents the environment read ${match[0]}, which the load-time scanner does not know`
    );
  }
}

/** The Markdown documents on the surfaces the rule ships through. */
function shippedDocuments(): Document[] {
  const documents: Document[] = [];
  for (const root of [DOCS_PAGES, BUNDLED_SKILL]) {
    for (const file of pageFiles(root)) {
      documents.push({ file, items: itemsOf(readFileSync(join(REPO, file), 'utf8')) });
    }
  }
  return documents;
}

/** The pages under a root directory, read from the tree rather than from a list. */
function pageFiles(root: string): string[] {
  const entries = readdirSync(resolve(REPO, root), { recursive: true });
  return entries
    .filter(
      (entry): entry is string =>
        typeof entry === 'string' && PAGE_EXTENSIONS.some(extension => entry.endsWith(extension))
    )
    .map(entry => `${root}/${entry}`);
}

/**
 * The items of a document: its markdown paragraphs, list items, table rows and admonitions.
 * A fenced code block is not prose and is not read.
 */
function itemsOf(text: string): Item[] {
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
  return found
    .map(lines => lines.join('\n').trim())
    .filter(line => line !== '')
    .map(line => ({ text: line, sentences: sentences(line) }));
}

/** The sentences of an item, so a claim is read in the sentence that makes it. */
function sentences(item: string): string[] {
  return item
    .split(/(?<=[.!?])\s+(?=[A-Z`"'(])/g)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence !== '');
}

/** A document that holds one paragraph of prose, for the guard's own controls. */
function documentOf(text: string): Document {
  return { file: 'a synthetic copy', items: itemsOf(text) };
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
 * The engine's context variable and its aliases. The engine resolves all of them to the
 * same value (`CONTEXT_VAR_PATTERN_STR`), so a copy may name any one of them.
 */
function contextFamilyNames(): Set<string> {
  const pattern = new RegExp(CONTEXT_VAR_PATTERN_STR);
  return new Set([...USER_CONTROLLED].filter(name => pattern.test(`$${name}`)));
}

/**
 * Whether a copy reads a name from the environment rather than claiming the engine splices
 * it into a source. The engine's own scanner treats such a name as a warning, because the
 * project's configured environment reaches the subprocess too.
 */
function readsFromEnvironment(sentence: string, name: string): boolean {
  const promised = promisedEnvironment(sentence);
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
 * The user-controlled variables a text names, with or without the `$`. The engine owns the
 * class, so the names come from the engine's own list.
 */
function classNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const name of USER_CONTROLLED) {
    if (new RegExp(`\\b${name}\\b`).test(text)) names.add(name);
  }
  return names;
}

/**
 * Whether a text speaks about the user-controlled variables, by name or by the phrase the
 * copies use for them.
 */
function speaksAboutClass(text: string): boolean {
  return classNames(text).size > 0 || /user-controlled/i.test(text);
}

/** The sentences of a document that speak about the user-controlled class. */
function classSentences(document: Document): string[] {
  return document.items.flatMap(item => item.sentences).filter(speaksAboutClass);
}

/**
 * The template references a text names, `$NAME`. A name that opens a structured reference
 * (`$LOOP_PREV.<nodeId>.output`, `$INPUTS.<name>`) is not a variable of its own.
 */
function templateReferences(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(TEMPLATE_REFERENCE)) {
    const after = text.slice(match.index + match[0].length).replace(/^`+/, '');
    if (STRUCTURED_REFERENCE.test(after)) continue;
    names.push(match[1]);
  }
  return names;
}

/** Whether a text talks about one of the exec node kinds. */
function mentionsKind(text: string, kind: ExecKind): boolean {
  return new RegExp(`\\b${kind}s?\\b`, 'i').test(text);
}

/** The runtimes an item talks about: a `bash:` body runs under `sh`, a `script:` body under a script runtime. */
function runtimesInPlay(text: string): Set<string> {
  const runtimes = new Set<string>();
  for (const kind of surfacesOf(text)) {
    if (kind === 'bash') runtimes.add('sh');
    else for (const runtime of SCRIPT_RUNTIMES) runtimes.add(runtime);
  }
  return runtimes;
}

/** The documents that state the rule, and so are copies of it. */
function copiesOf(documents: readonly Document[]): Document[] {
  return documents.filter(isCopy);
}

/** Whether a document states the rule, and so is a copy of it. */
function isCopy(document: Document): boolean {
  return document.items.some(item =>
    item.sentences.some(sentence => speaksAboutClass(sentence) && surfacesOf(sentence).size > 0)
  );
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

/** The environment variables a text promises. */
function promisedEnvironment(text: string): PromisedEnvironment {
  const accessor = new Map<string, Set<string>>();
  const shell = new Set<string>();
  const listed = new Set<string>();
  for (const { pattern, nameIndex, runtime } of ENVIRONMENT_READ_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const name = match[nameIndex];
      if (name === undefined) continue;
      const names = accessor.get(runtime) ?? new Set<string>();
      names.add(name);
      accessor.set(runtime, names);
    }
  }
  for (const match of text.matchAll(SHELL_ACCESS)) shell.add(match[1]);
  for (const match of text.matchAll(BACKTICKED_NAME)) listed.add(match[1]);
  return { accessor, shell, listed };
}

/** Every environment variable a statement promises, in any form. */
function promisedNames(sentence: string): Set<string> {
  const promised = promisedEnvironment(sentence);
  const names = new Set<string>(promised.shell);
  for (const runtimeNames of promised.accessor.values()) {
    for (const name of runtimeNames) names.add(name);
  }
  for (const name of promised.listed) names.add(name);
  return names;
}

/**
 * Whether the load-time scanner knows an environment read. The scanner's table owns the
 * supported spellings and the runtime each belongs to; an empty set of runtimes asks about
 * every runtime the scanner knows.
 */
function scannerKnows(expression: string, runtimes: ReadonlySet<string>): boolean {
  return ENVIRONMENT_READ_PATTERNS.some(({ pattern, runtime }) => {
    if (runtimes.size > 0 && !runtimes.has(runtime)) return false;
    return new RegExp(pattern.source, pattern.flags.replace('g', '')).test(expression);
  });
}
