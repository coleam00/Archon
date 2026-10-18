import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  collectBundleSources,
  readBundleIndex,
} from '../packages/workflows/src/defaults/bundle-inventory';
import { ROOT_TEST_PLAN } from './repo-tests';
import {
  BUILD_INPUTS,
  changedFilesBetween,
  diffRange,
  proofFromPullRequestRun,
  shouldRunTestSuite,
  shouldRunWorkspaceTests,
  workspaceTestInputs,
  type EventPayload,
  type GitHubGet,
} from './should-run-test-suite';

const EMPTY_GIT_SHA = '0000000000000000000000000000000000000000';
const SCRIPT = resolve(import.meta.dir, 'should-run-test-suite.ts');

/** Runs the script the way the workflow does: GitHub names the event and hands over its payload. */
function runDecision(
  trackTempRoot: (root: string) => string,
  eventName: string,
  payload: EventPayload,
  cwd = process.cwd(),
  args: readonly string[] = []
): { exitCode: number; stdout: string; stderr: string } {
  const eventDir = trackTempRoot(mkdtempSync(join(tmpdir(), 'run-suite-event-')));
  const eventPath = join(eventDir, 'event.json');
  writeFileSync(eventPath, JSON.stringify(payload));
  const result = Bun.spawnSync(['bun', SCRIPT, ...args], {
    cwd,
    // An empty token keeps every push decision here away from the GitHub API.
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: eventName,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_TOKEN: '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString(),
  };
}

/**
 * Inspects concrete source paths, including local helpers, without executing test modules.
 * Dynamic inventories (bundled prompts and skills) have their own owner-based guards below.
 */
function markdownTestInputs(repo: string): Map<string, Set<string>> {
  const tracked = new Set(gitIn(repo, 'ls-files', '-z').split('\0').filter(Boolean));
  const sources = [...tracked].filter(file => /\.tsx?$/.test(file));
  const tests = sources.filter(file => /\.(?:test|spec)\.tsx?$/.test(file));
  if (tests.length === 0) throw new Error(`No tracked tests in ${repo}`);
  const program = ts.createProgram(
    sources.map(file => resolve(repo, file)),
    {
      noResolve: true,
      noLib: true,
      target: ts.ScriptTarget.Latest,
    }
  );
  const checker = program.getTypeChecker();
  const found = new Map<string, Set<string>>();
  const rootDirectories = ROOT_TEST_PLAN.flatMap(step =>
    step.kind === 'root' ? step.selectors.map(selector => resolve(repo, selector)) : []
  );
  const cwdFor = (file: string): string => {
    if (rootDirectories.some(root => file.startsWith(`${root}/`) || file.startsWith(`${root}\\`))) {
      return repo;
    }
    const parts = relative(repo, file).split(/[\\/]/);
    return parts[0] === 'packages' && tracked.has(`packages/${parts[1]}/package.json`)
      ? join(repo, 'packages', parts[1])
      : repo;
  };
  const sourcePaths = new Set(sources.map(file => resolve(repo, file)));
  const localSource = (owner: ts.SourceFile, name: string): ts.SourceFile | undefined => {
    if (!name.startsWith('.')) return undefined;
    const stem = resolve(dirname(owner.fileName), name);
    const path = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']
      .map(suffix => stem + suffix)
      .find(candidate => sourcePaths.has(candidate));
    if (path === undefined) return undefined;
    const source = program.getSourceFile(path);
    if (!source) throw new Error(`Cannot read tracked source ${path}`);
    return source;
  };
  const declaration = (node: ts.Node): ts.Declaration | undefined =>
    checker.getSymbolAtLocation(node)?.declarations?.[0];
  const imported = (node: ts.Expression): { module: string; name: string } | undefined => {
    const binding = declaration(ts.isPropertyAccessExpression(node) ? node.expression : node);
    if (binding && ts.isBindingElement(binding) && ts.isObjectBindingPattern(binding.parent)) {
      const variable = binding.parent.parent;
      if (ts.isVariableDeclaration(variable)) {
        let initializer = variable.initializer;
        if (initializer && ts.isAwaitExpression(initializer)) initializer = initializer.expression;
        if (
          initializer &&
          ts.isCallExpression(initializer) &&
          initializer.expression.kind === ts.SyntaxKind.ImportKeyword &&
          initializer.arguments[0] &&
          ts.isStringLiteral(initializer.arguments[0])
        )
          return {
            module: initializer.arguments[0].text,
            name: (binding.propertyName ?? binding.name).getText(),
          };
      }
    }
    if (binding && ts.isImportSpecifier(binding) && ts.isIdentifier(node)) {
      const owner = binding.parent.parent.parent;
      if (ts.isStringLiteral(owner.moduleSpecifier)) {
        return {
          module: owner.moduleSpecifier.text,
          name: (binding.propertyName ?? binding.name).text,
        };
      }
    }
    if (
      binding &&
      (ts.isNamespaceImport(binding) || ts.isImportClause(binding)) &&
      ts.isPropertyAccessExpression(node)
    ) {
      const owner = ts.isNamespaceImport(binding) ? binding.parent.parent : binding.parent;
      if (ts.isStringLiteral(owner.moduleSpecifier)) {
        return { module: owner.moduleSpecifier.text, name: node.name.text };
      }
    }
    return undefined;
  };
  const targetDeclaration = (node: ts.Expression): ts.Declaration | undefined => {
    const origin = imported(node);
    const source = origin && localSource(node.getSourceFile(), origin.module);
    const symbol = source && checker.getSymbolAtLocation(source);
    return symbol
      ? checker.getExportsOfModule(symbol).find(item => item.name === origin?.name)
          ?.valueDeclaration
      : declaration(node);
  };
  const parameters = new Map<ts.Declaration, string>();
  const activeFunctions = new Set<ts.FunctionDeclaration>();
  const active = new Set<ts.Node>();
  function value(node: ts.Expression | undefined, cwd: string): string | undefined {
    if (!node || active.has(node)) return undefined;
    active.add(node);
    try {
      if (ts.isStringLiteralLike(node)) return node.text;
      if (ts.isTemplateExpression(node)) {
        let result = node.head.text;
        for (const span of node.templateSpans) {
          const part = value(span.expression, cwd);
          if (part === undefined) return undefined;
          result += part + span.literal.text;
        }
        return result;
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const left = value(node.left, cwd);
        const right = value(node.right, cwd);
        return left !== undefined && right !== undefined ? left + right : undefined;
      }
      if (
        ts.isParenthesizedExpression(node) ||
        ts.isAsExpression(node) ||
        ts.isTypeAssertionExpression(node) ||
        ts.isSatisfiesExpression(node) ||
        ts.isNonNullExpression(node)
      )
        return value(node.expression, cwd);
      if (ts.isIdentifier(node)) {
        const binding = declaration(node);
        if (binding && parameters.has(binding)) return parameters.get(binding);
        if (
          binding &&
          ts.isVariableDeclaration(binding) &&
          ts.isVariableDeclarationList(binding.parent) &&
          (binding.parent.flags & ts.NodeFlags.Const) !== 0
        ) {
          return value(binding.initializer, cwd);
        }
      }
      if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
        const origin = imported(node);
        const source = origin && localSource(node.getSourceFile(), origin.module);
        const symbol = source && checker.getSymbolAtLocation(source);
        const exported =
          symbol && checker.getExportsOfModule(symbol).find(item => item.name === origin?.name);
        const target = exported?.valueDeclaration;
        if (
          target &&
          ts.isVariableDeclaration(target) &&
          ts.isVariableDeclarationList(target.parent) &&
          (target.parent.flags & ts.NodeFlags.Const) !== 0
        )
          return value(target.initializer, cwd);
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isMetaProperty(node.expression) &&
        node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
        node.expression.name.text === 'meta'
      ) {
        if (node.name.text === 'dir') return dirname(node.getSourceFile().fileName);
        if (node.name.text === 'url') return pathToFileURL(node.getSourceFile().fileName).href;
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const args: string[] = [];
        for (const argument of node.arguments ?? []) {
          const resolved = value(argument, cwd);
          if (resolved === undefined) return undefined;
          args.push(resolved);
        }
        const origin = imported(node.expression);
        if (origin?.module === 'node:path' || origin?.module === 'path') {
          if (origin.name === 'join') return join(...args);
          if (origin.name === 'resolve') return resolve(cwd, ...args);
          if (origin.name === 'dirname' && args.length === 1) return dirname(args[0]);
        }
        if (origin?.module === 'node:url' || origin?.module === 'url') {
          if (origin.name === 'fileURLToPath' && args[0]?.startsWith('file:'))
            return fileURLToPath(args[0]);
          if (origin.name === 'pathToFileURL' && args.length === 1)
            return pathToFileURL(resolve(cwd, args[0])).href;
        }
        if (
          ts.isNewExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'URL' &&
          !declaration(node.expression) &&
          (args.length === 1 || args.length === 2)
        ) {
          if (!args[0]?.startsWith('file:') && !args[1]?.startsWith('file:')) return undefined;
          const url = new URL(args[0], args[1]);
          return url.protocol === 'file:' ? url.href : undefined;
        }
      }
      return undefined;
    } finally {
      active.delete(node);
    }
  }
  const pending = tests.map(file => ({
    file: resolve(repo, file),
    cwd: cwdFor(resolve(repo, file)),
  }));
  const inspected = new Set(pending.map(({ file, cwd }) => JSON.stringify([file, cwd])));
  for (const { file, cwd } of pending) {
    const source = program.getSourceFile(file);
    if (!source) throw new Error(`Cannot read tracked source ${file}`);
    const errors = program.getSyntacticDiagnostics(source);
    if (errors.length)
      throw new Error(
        ts.formatDiagnosticsWithColorAndContext(errors, {
          getCanonicalFileName: name => name,
          getCurrentDirectory: () => repo,
          getNewLine: () => '\n',
        })
      );
    const trackedMarkdown = (candidate: string | undefined): string | undefined => {
      if (candidate === undefined) return undefined;
      const absolute = candidate.startsWith('file:')
        ? fileURLToPath(candidate)
        : resolve(cwd, candidate);
      const path = relative(repo, absolute).replaceAll('\\', '/');
      return path.endsWith('.md') && tracked.has(path) ? path : undefined;
    };
    const record = (candidate: string | undefined): void => {
      const path = trackedMarkdown(candidate);
      if (!path) return;
      const readers = found.get(path) ?? new Set<string>();
      readers.add(relative(repo, file).replaceAll('\\', '/'));
      found.set(path, readers);
    };
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) ||
        ts.isNewExpression(node) ||
        ts.isTemplateExpression(node) ||
        ts.isBinaryExpression(node)
      )
        record(value(node, cwd));
      if (ts.isCallExpression(node)) {
        const origin = imported(node.expression);
        const fsRead =
          origin &&
          ['node:fs', 'fs', 'node:fs/promises', 'fs/promises'].includes(origin.module) &&
          ['readFileSync', 'readFile'].includes(origin.name);
        const bunRead =
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === 'Bun' &&
          !declaration(node.expression.expression) &&
          node.expression.name.text === 'file';
        if (fsRead || bunRead) {
          const argument = node.arguments[0];
          const candidate = value(argument, cwd);
          if (candidate === undefined && argument) {
            const inspectUnresolved = (part: ts.Node): void => {
              if (ts.isCallExpression(part)) {
                const origin = imported(part.expression);
                if (
                  origin &&
                  ['node:path', 'path'].includes(origin.module) &&
                  ['join', 'resolve'].includes(origin.name) &&
                  value(part.arguments[0], cwd) === undefined
                )
                  return;
              }
              if (ts.isExpression(part) && trackedMarkdown(value(part, cwd))) {
                throw new Error(
                  `Cannot resolve Markdown read in ${relative(repo, file)}: ${argument.getText()}`
                );
              }
              ts.forEachChild(part, inspectUnresolved);
            };
            inspectUnresolved(argument);
          }
          record(candidate);
        }
        const fn = targetDeclaration(node.expression);
        if (fn && ts.isFunctionDeclaration(fn) && fn.body && !activeFunctions.has(fn)) {
          const arguments_ = node.arguments.map(argument => value(argument, cwd));
          if (arguments_.some(argument => argument?.endsWith('.md'))) {
            const previous = new Map(parameters);
            fn.parameters.forEach((parameter, index) => {
              const argument = arguments_[index];
              if (argument !== undefined) parameters.set(parameter, argument);
            });
            activeFunctions.add(fn);
            try {
              visit(fn.body);
            } finally {
              activeFunctions.delete(fn);
              parameters.clear();
              for (const [parameter, argument] of previous) parameters.set(parameter, argument);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
        continue;
      const specifier = statement.moduleSpecifier.text;
      if (specifier.endsWith('.md')) record(resolve(dirname(source.fileName), specifier));
      const target = localSource(source, specifier);
      if (target) {
        const key = JSON.stringify([target.fileName, cwd]);
        if (!inspected.has(key)) {
          inspected.add(key);
          pending.push({ file: target.fileName, cwd });
        }
      }
    }
  }
  return found;
}

function omittedMarkdownInputs(inputs: Map<string, Set<string>>): string[] {
  return [...inputs]
    .filter(([path]) => !shouldRunTestSuite([path]))
    .map(([path, readers]) => `${path} read by ${[...readers].join(', ')}`);
}

describe('test-suite change decision', () => {
  const trackTempRoot = trackTempRoots();
  const workspaceInputs = workspaceTestInputs(resolve(import.meta.dir, '..'));

  test('every tracked Markdown path constructed by tests runs the suite', () => {
    const inputs = markdownTestInputs(resolve(import.meta.dir, '..'));
    expect(inputs.size).toBeGreaterThan(0);
    expect(omittedMarkdownInputs(inputs)).toEqual([]);
  });

  test.each(BUILD_INPUTS.filter(path => path.endsWith('.md')))(
    'runs suite and workspace tests for Markdown input %s',
    file => {
      expect(shouldRunTestSuite([file])).toBe(true);
      expect(shouldRunWorkspaceTests([file], workspaceInputs)).toBe(true);
    }
  );

  test('an unknown source file runs the suite', () => {
    expect(shouldRunTestSuite(['unknown.ts'])).toBe(true);
  });

  test('new readers and imported paths are checked without treating fixtures as checkout inputs', () => {
    const repo = trackTempRoot(mkdtempSync(join(tmpdir(), 'markdown-inputs-')));
    const files: Record<string, string> = {
      'docs/url.md': '',
      'docs/split.md': '',
      'docs/imported.md': '',
      'docs/converted.md': '',
      'docs/direct.md': '',
      'docs/bun.md': '',
      'docs/helper-read.md': '',
      'docs/template.md': '',
      'docs/concat.md': '',
      'docs/text.md': '',
      'docs/indirect.md': '',
      'docs/returned.md': '',
      'docs/dynamic.md': '',
      'docs/unread.md': '',
      'README.md': '',
      'packages/a/package.json': '{}',
      'packages/a/docs/relative.md': '',
      'packages/a/reader.spec.tsx': `
        import { readFile } from 'node:fs/promises';
        await readFile('docs/relative.md', 'utf8');
      `,
      'scripts/helper.ts': `
        import * as paths from 'node:path';
        import { readFileSync } from 'node:fs';
        export const doc = paths.resolve(import.meta.dir, '..', 'docs', 'imported.md');
        readFileSync('docs/helper-read.md', 'utf8');
        export function readDoc(path: string) { return readFileSync(path, 'utf8'); }
        export function docsInput() { return import.meta.dir + '/../docs/returned.md'; }
      `,
      'scripts/new-reader.test.ts': `
        import { readFileSync as read } from 'node:fs';
        import { readFile } from 'node:fs/promises';
        import { join as assemble, dirname } from 'node:path';
        import * as urls from 'node:url';
        import { doc as importedPath, readDoc, docsInput } from './helper';
        import text from '../docs/text.md' with { type: 'text' };
        const { readFileSync: dynamicRead } = await import('node:fs');
        dynamicRead('docs/dynamic.md', 'utf8');
        readDoc('docs/indirect.md');
        read(docsInput(), 'utf8');
        read(import.meta.dir + '/../docs/concat.md', 'utf8');
        read(\`\${import.meta.dir}/../docs/template.md\`, 'utf8');
        import { mkdtempSync } from 'node:fs';
        import { tmpdir } from 'node:os';
        const root = dirname(import.meta.dir);
        const split = assemble(root, 'docs', 'split.md') as string;
        read(split, 'utf8');
        read(new URL('../docs/url.md', import.meta.url), 'utf8');
        await readFile(importedPath, 'utf8');
        read(urls.fileURLToPath(new URL('../docs/converted.md', import.meta.url)), 'utf8');
        read('docs/direct.md', 'utf8');
        Bun.file('docs/bun.md');
        read(new URL('https://example.com/docs/unread.md'), 'utf8');
        const temp = mkdtempSync(assemble(tmpdir(), 'test-'));
        read(assemble(temp, 'README.md'), 'utf8');
        read(assemble(root, '..', 'outside.md'), 'utf8');
        const loopA = loopB;
        const loopB = loopA;
        read(loopA, 'utf8');
        function otherJoin(...args: string[]) { return args.join(''); }
        otherJoin(root, 'docs/unread.md');
        function shadowed() {
          const assemble = otherJoin;
          assemble(root, 'docs/unread.md');
        }
        expect('README.md').toBe('README.md');
      `,
    };
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, file)), { recursive: true });
      writeFileSync(join(repo, file), content);
    }
    gitIn(repo, 'init', '-q');
    gitIn(repo, 'add', '.');
    const inputs = markdownTestInputs(repo);
    expect([...inputs.keys()].sort()).toEqual([
      'docs/bun.md',
      'docs/concat.md',
      'docs/converted.md',
      'docs/direct.md',
      'docs/dynamic.md',
      'docs/helper-read.md',
      'docs/imported.md',
      'docs/indirect.md',
      'docs/returned.md',
      'docs/split.md',
      'docs/template.md',
      'docs/text.md',
      'docs/url.md',
      'packages/a/docs/relative.md',
    ]);
    expect(inputs.get('docs/imported.md')?.has('scripts/new-reader.test.ts')).toBe(true);
    expect(omittedMarkdownInputs(inputs)).toContain(
      'docs/url.md read by scripts/new-reader.test.ts'
    );
    expect(omittedMarkdownInputs(inputs)).toHaveLength(inputs.size);
  });

  test.each(['readFileSync', 'readFile', 'Bun.file'])(
    'an unresolved %s of a tracked Markdown reference fails with its consumer',
    reader => {
      const repo = trackTempRoot(mkdtempSync(join(tmpdir(), 'markdown-unresolved-')));
      mkdirSync(join(repo, 'docs'));
      writeFileSync(join(repo, 'docs/input.md'), 'input');
      writeFileSync(
        join(repo, 'reader.test.ts'),
        `
      import { readFileSync } from 'node:fs';
      import { readFile } from 'node:fs/promises';
      import { transform } from 'external-reader';
      ${reader}(transform('docs/input.md'), 'utf8');
    `
      );
      gitIn(repo, 'init', '-q');
      gitIn(repo, 'add', '.');
      expect(() => markdownTestInputs(repo)).toThrow(
        "Cannot resolve Markdown read in reader.test.ts: transform('docs/input.md')"
      );
    }
  );

  test.each(['push', 'pull_request'])('%s skips Markdown-only changes', () => {
    expect(shouldRunTestSuite(['README.md', 'packages/core/notes.md'])).toBe(false);
  });

  test.each(['push', 'pull_request'])('%s skips docs-source-only changes', () => {
    expect(
      shouldRunTestSuite([
        'packages/docs-web/src/content/docs/guide.mdx',
        'packages/docs-web/public/logo.svg',
      ])
    ).toBe(false);
  });

  test.each(['push', 'pull_request'])('%s runs when the docs manifest changes', () => {
    expect(shouldRunTestSuite(['packages/docs-web/package.json'])).toBe(true);
  });

  test('runs for a non-documentation change after thousands of documentation files', () => {
    const changedFiles = [
      ...Array.from({ length: 3_001 }, (_, index) => `docs/${index}.md`),
      'packages/docs-web/package.json',
    ];

    expect(shouldRunTestSuite(changedFiles)).toBe(true);
  });

  test.each([
    ['.archon/workflows/sdlc/implement/commands/implement.md', 'a packaged command prompt'],
    ['.archon/workflows/sdlc/.shared/policy/triage.md', 'a pack .shared/ document'],
    ['.claude/skills/archon-cli/SKILL.md', 'the bundled CLI skill'],
    ['packages/docs-web/src/content/docs/reference/provider-capabilities.md', 'a generated doc'],
  ])('runs for %s, which is %s rather than prose', file => {
    expect(shouldRunTestSuite([file])).toBe(true);
  });

  test('still skips genuine prose, inside the docs site and out', () => {
    expect(
      shouldRunTestSuite([
        'README.md',
        'AGENTS.md',
        'packages/docs-web/src/content/docs/guides/authoring-workflows.md',
      ])
    ).toBe(false);
  });

  test.each([
    '.archon/workflows/sdlc/README.md',
    '.archon/workflows/sdlc/CONSTITUTION.md',
    '.archon/workflows/sdlc/validate/README.md',
  ])('skips pack prose %s, which the bundle does not embed', file => {
    expect(shouldRunTestSuite([file])).toBe(false);
  });

  /** `bundle-inventory.ts` selects what the binary embeds, so it owns this family. */
  test('every Markdown file the bundle embeds runs the suite', async () => {
    const repoRoot = resolve(import.meta.dir, '..');
    const sources = await collectBundleSources(
      join(repoRoot, '.archon/workflows'),
      await readBundleIndex()
    );
    const markdown = sources
      .map(source => relative(repoRoot, source.sourcePath).replaceAll('\\', '/'))
      .filter(path => path.endsWith('.md'));

    expect(markdown.length).toBeGreaterThan(0);
    for (const file of markdown) expect([file, shouldRunTestSuite([file])]).toEqual([file, true]);
  });

  /**
   * The exclusion list above is written by hand, so it can only stay true if something checks it
   * against what the build actually reads. `bundled-skill.ts` compiles each of these files into
   * the CLI with a text import, which makes its import list the owning source for that family.
   */
  test('every Markdown file compiled into the CLI skill runs the suite', () => {
    const bundledSkill = readFileSync(
      resolve(import.meta.dir, '../packages/cli/src/bundled-skill.ts'),
      'utf8'
    );
    const imported = [...bundledSkill.matchAll(/'[^']*\/(\.claude\/skills\/[^']+\.md)'/g)].map(
      match => match[1]
    );

    expect(imported.length).toBeGreaterThan(0);
    for (const file of imported) expect(shouldRunTestSuite([file])).toBe(true);
  });

  test('a push that creates a branch has nothing to compare, so the suite runs', () => {
    expect(diffRange('push', { before: EMPTY_GIT_SHA, after: 'unavailable-head' })).toBeNull();
    expect(diffRange('workflow_dispatch', {})).toBeNull();
  });

  test('a push spans what it added', () => {
    expect(diffRange('push', { before: 'previous-tip', after: 'new-tip' })).toEqual({
      base: 'previous-tip',
      head: 'new-tip',
    });
  });

  test('a pull request is judged on its whole diff, never on the previous push', () => {
    // A `synchronize` payload carries both. `before` is the previous push's head.
    const synchronize: EventPayload = {
      before: 'previous-push-head',
      after: 'pr-head',
      pull_request: { base: { sha: 'pr-base' }, head: { sha: 'pr-head' } },
    };
    expect(diffRange('pull_request', synchronize)).toEqual({ base: 'pr-base', head: 'pr-head' });
  });

  test('a payload missing the commits it needs is fatal rather than a skip', () => {
    expect(() => diffRange('pull_request', { before: 'a', after: 'b' })).toThrow(
      'pull_request.base.sha'
    );
    expect(() => diffRange('push', {})).toThrow('before');
  });

  /**
   * A force-push leaves `github.event.before` unreachable. The decision must still be a decision:
   * an empty stdout here is read as "skip" by every downstream gate.
   */
  test('an unreadable diff resolves to running the suite, with the cause on stderr', () => {
    const unreachable = '1'.repeat(40);
    const result = runDecision(
      trackTempRoot,
      'pull_request',
      { pull_request: { base: { sha: unreachable }, head: { sha: 'HEAD' } } },
      process.cwd()
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('true');
    expect(result.stderr).toContain(`Could not compare ${unreachable}..HEAD`);
  });

  test('a push without API credentials runs the suite and says why', () => {
    const result = runDecision(trackTempRoot, 'push', { before: 'HEAD~1', after: 'HEAD' });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('true');
    expect(result.stderr).toContain('No pull request run proves this push');
    expect(result.stderr).toContain('GITHUB_TOKEN');
  });

  test('a bad event stays fatal, so the step cannot publish an empty decision', () => {
    const result = runDecision(trackTempRoot, 'not-a-github-event', {});

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Unsupported GitHub event: not-a-github-event');
  });
});

describe('diff mode', () => {
  const trackTempRoot = trackTempRoots();

  const git = (cwd: string, ...args: string[]): void => {
    const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  };

  const commit = (repo: string, file: string, message: string): string => {
    writeFileSync(join(repo, file), `${message}\n`);
    git(repo, 'add', file);
    git(repo, 'commit', '-m', message);
    return Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: repo, stdout: 'pipe' })
      .stdout.toString()
      .trim();
  };

  /**
   * The shape that disabled this filter in production: a docs-only branch whose base moved on.
   * A two-dot `git diff base head` also reports the base's own new commit and forces the suite;
   * the merge-base diff reports only what the branch changed.
   */
  function docsBranchWithMovedBase(): { repo: string; base: string; head: string } {
    const repo = trackTempRoot(mkdtempSync(join(tmpdir(), 'run-suite-diff-')));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    commit(repo, 'seed.ts', 'seed');

    git(repo, 'checkout', '-q', '-b', 'docs-branch');
    const head = commit(repo, 'GUIDE.md', 'docs only');

    git(repo, 'checkout', '-q', 'main');
    const base = commit(repo, 'unrelated.ts', 'landed on the base after the branch point');

    return { repo, base, head };
  }

  test('a docs-only branch skips even when the base branch moved on', () => {
    const { repo, base, head } = docsBranchWithMovedBase();
    // Seen red against the previous two-dot call: it also reported `unrelated.ts`.
    expect(changedFilesBetween(base, head, repo)).toEqual(['GUIDE.md']);
    expect(shouldRunTestSuite(changedFilesBetween(base, head, repo))).toBe(false);
    const result = runDecision(
      trackTempRoot,
      'pull_request',
      { pull_request: { base: { sha: base }, head: { sha: head } } },
      repo
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('false');
  });

  test.each([
    ['packages/docs-web/src/content/docs/reference/database.md', 'true'],
    ['packages/docs-web/src/content/docs/guides/authoring-workflows.md', 'false'],
  ])('both CI modes classify a change only to %s', (file, expected) => {
    const repo = trackTempRoot(mkdtempSync(join(tmpdir(), 'markdown-decision-')));
    gitIn(repo, 'init', '-q', '-b', 'main');
    gitIn(repo, 'config', 'user.email', 'test@example.com');
    gitIn(repo, 'config', 'user.name', 'Test');
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    const base = commit(repo, file, 'seed');
    const head = commit(repo, file, 'change only Markdown');
    expect(changedFilesBetween(base, head, repo)).toEqual([file]);
    for (const args of [[], ['--workspace-tests']]) {
      const result = runDecision(
        trackTempRoot,
        'pull_request',
        { pull_request: { base: { sha: base }, head: { sha: head } } },
        repo,
        args
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe(expected);
    }
  });

  test.each(
    process.platform === 'win32'
      ? ['é.yaml']
      : ['é.yaml', 'quote".yaml', 'back\\slash.yaml', 'tab\t.yaml', 'line\n.yaml']
  )('the decision preserves Git-quoted filename %j', filename => {
    const repo = trackTempRoot(mkdtempSync(join(tmpdir(), 'run-fixture-path-')));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'core.quotepath', 'true');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    const base = commit(repo, 'seed.ts', 'seed');
    mkdirSync(join(repo, '.archon/workflows/sdlc/fixtures'), { recursive: true });
    const file = `.archon/workflows/sdlc/fixtures/${filename}`;
    const head = commit(repo, file, 'fixture change');
    expect(changedFilesBetween(base, head, repo)).toEqual([file]);
    const result = runDecision(
      trackTempRoot,
      'pull_request',
      { pull_request: { base: { sha: base }, head: { sha: head } } },
      repo
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('true');
  });

  test('a code change on the branch still runs the suite', () => {
    const repo = trackTempRoot(mkdtempSync(join(tmpdir(), 'run-suite-diff-')));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    const base = commit(repo, 'seed.ts', 'seed');
    git(repo, 'checkout', '-q', '-b', 'code-branch');
    const head = commit(repo, 'feature.ts', 'real code');

    expect(shouldRunTestSuite(changedFilesBetween(base, head, repo))).toBe(true);
  });

  /**
   * The PR #3415 shape: a code push, then a docs-only push. Concurrency cancels the first push's
   * run, so the second push's decision is the only one the PR head gets.
   */
  test('a docs-only push on top of a code push still runs the suite for the pull request', () => {
    const repo = trackTempRoot(mkdtempSync(join(tmpdir(), 'run-suite-diff-')));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    const prBase = commit(repo, 'seed.ts', 'seed');
    git(repo, 'checkout', '-q', '-b', 'feature');
    mkdirSync(join(repo, 'packages/workflows/src'), { recursive: true });
    const codePush = commit(repo, 'packages/workflows/src/dry-run.ts', 'real code');
    const docsPush = commit(repo, 'GUIDE.md', 'docs only');

    const result = runDecision(
      trackTempRoot,
      'pull_request',
      {
        before: codePush,
        after: docsPush,
        pull_request: { base: { sha: prBase }, head: { sha: docsPush } },
      },
      repo
    );

    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('true');
  });
});

describe('inert paths', () => {
  test.each([
    '.gitignore',
    'LICENSE',
    '.env.example',
    '.archon/config.example.yaml',
    'assets/logo.png',
  ])('skips %s, which no check reads', file => {
    expect(shouldRunTestSuite([file])).toBe(false);
  });

  test.each([
    ['Dockerfile', 'the docker-build job'],
    ['.dockerignore', 'the docker-build job'],
    ['biome.jsonc', 'lint and format:check'],
    ['homebrew/archon.rb', 'build:checksums'],
    ['scripts/install.ps1', 'test:install'],
    ['.github/workflows/test.yml', 'the gate itself'],
    ['packages/web/public/favicon.png', 'the web build'],
    ['Caddyfile.example', 'reverse-proxy.test.ts and caddy-recipe.test.ts'],
    ['.gitattributes', 'every checkout'],
  ])('runs for %s, which is read by %s', file => {
    expect(shouldRunTestSuite([file])).toBe(true);
  });
});

describe('decision arguments and events', () => {
  const track = trackTempRoots();
  test.each([
    ['workflow_dispatch', {}],
    ['push', { before: EMPTY_GIT_SHA }],
    ['push', { before: 'unreachable', after: 'HEAD' }],
  ] as const)('runs for %s without a usable diff', (event, payload) => {
    const result = runDecision(track, event, payload, process.cwd());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('true');
  });
  test.each([{ args: ['--unsupported'] }, { args: ['--workspace-tests', '--unsupported'] }])(
    'rejects unknown arguments %j',
    ({ args }) => {
      const result = runDecision(track, 'workflow_dispatch', {}, process.cwd(), args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe('');
    }
  );
  test('rejects malformed events', () => {
    const result = runDecision(track, 'pull_request', {}, process.cwd());
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
  });
});

describe('workspace test selection', () => {
  const track = trackTempRoots();
  const REPO_ROOT = resolve(import.meta.dir, '..');
  const inputs = workspaceTestInputs(REPO_ROOT);

  test('derives the root scripts the package tests read from this repository', () => {
    for (const runnerFile of [
      'scripts/package-tests.ts',
      'scripts/package-test-groups.ts',
      'scripts/test-preload.ts',
      'scripts/check-schema-upgrades.ts',
    ]) {
      expect(inputs.has(runnerFile)).toBe(true);
    }
    expect(inputs.has('scripts/should-run-test-suite.ts')).toBe(false);
  });

  test('skips for root scripts no package test reads, and for prose', () => {
    expect(
      shouldRunWorkspaceTests(
        ['scripts/should-run-test-suite.ts', 'scripts/should-run-test-suite.test.ts', 'NOTES.md'],
        inputs
      )
    ).toBe(false);
  });

  test.each([
    'scripts/package-tests.ts',
    'packages/core/src/index.ts',
    '.archon/scripts/__tests__/x.test.ts',
    '.github/workflows/test.yml',
  ])('runs for %s', file => {
    expect(shouldRunWorkspaceTests(['scripts/should-run-test-suite.ts', file], inputs)).toBe(true);
  });

  test('a deleted root script a package still names counts as an input', () => {
    const root = track(mkdtempSync(join(tmpdir(), 'workspace-inputs-')));
    gitIn(root, 'init', '-q', '-b', 'main');
    mkdirSync(join(root, 'packages/a'), { recursive: true });
    writeFileSync(join(root, 'packages/a/package.json'), '{"test":"bun ../../scripts/gone.ts"}');
    gitIn(root, 'add', '.');
    expect(workspaceTestInputs(root).has('scripts/gone.ts')).toBe(false);
    expect(workspaceTestInputs(root, ['scripts/gone.ts']).has('scripts/gone.ts')).toBe(true);
  });

  test('the script decides a pull request from its diff and the derived inputs', () => {
    const repo = track(mkdtempSync(join(tmpdir(), 'workspace-decision-')));
    gitIn(repo, 'init', '-q', '-b', 'main');
    gitIn(repo, 'config', 'user.email', 'test@example.com');
    gitIn(repo, 'config', 'user.name', 'Test');
    mkdirSync(join(repo, 'packages/a'), { recursive: true });
    mkdirSync(join(repo, 'scripts'));
    writeFileSync(join(repo, 'packages/a/package.json'), '{"test":"bun ../../scripts/run.ts"}');
    writeFileSync(join(repo, 'scripts/run.ts'), "import './shared';\n");
    writeFileSync(join(repo, 'scripts/shared.ts'), '');
    writeFileSync(join(repo, 'scripts/tool.ts'), '');
    gitIn(repo, 'add', '.');
    gitIn(repo, 'commit', '-q', '-m', 'seed');
    const base = gitIn(repo, 'rev-parse', 'HEAD');

    const decide = (file: string): string => {
      gitIn(repo, 'checkout', '-q', '-B', 'change', base);
      writeFileSync(join(repo, file), 'changed\n');
      gitIn(repo, 'commit', '-q', '-am', `change ${file}`);
      const head = gitIn(repo, 'rev-parse', 'HEAD');
      const result = runDecision(
        track,
        'pull_request',
        { pull_request: { base: { sha: base }, head: { sha: head } } },
        repo,
        ['--workspace-tests']
      );
      expect(result.exitCode).toBe(0);
      return result.stdout;
    };

    expect(decide('scripts/tool.ts')).toBe('false');
    expect(decide('scripts/shared.ts')).toBe('true');
  });
});

function gitIn(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

describe('a push proven by its pull request run', () => {
  const PUSH = { head: 'squash-commit' };
  const PR_BASE = 'pr-base';
  const PR_HEAD = 'pr-head';
  const RUN_URL = 'https://github.com/coleam00/Archon/actions/runs/7';
  const JOBS = 'actions/runs/7/jobs?filter=latest&per_page=100';
  const EVENTS = (page: number) => `issues/4/events?per_page=100&page=${page}`;

  /** The API answers for a squash merge of a pull request whose head contained its base. */
  function provenApi(head = PUSH.head): Record<string, unknown> {
    return {
      [`commits/${head}/pulls`]: [
        { number: 3, merge_commit_sha: 'other', head: { sha: 'other-head' } },
        { number: 4, merge_commit_sha: head, base: { sha: PR_BASE }, head: { sha: PR_HEAD } },
      ],
      [EVENTS(1)]: [{ event: 'labeled' }, { event: 'head_ref_force_pushed' }],
      [`compare/${PR_BASE}...${PR_HEAD}`]: { status: 'ahead' },
      [`git/commits/${head}`]: { tree: { sha: 'tree-a' } },
      [`git/commits/${PR_HEAD}`]: { tree: { sha: 'tree-a' } },
      [`actions/workflows/test.yml/runs?head_sha=${PR_HEAD}&event=pull_request&status=success`]: {
        workflow_runs: [{ id: 7, html_url: RUN_URL }],
      },
      [JOBS]: {
        total_count: 2,
        jobs: [
          { name: 'changes', conclusion: 'success' },
          { name: 'test (windows-latest, packages)', conclusion: 'success' },
        ],
      },
    };
  }

  const getFrom =
    (answers: Record<string, unknown>): GitHubGet =>
    async path => {
      if (!(path in answers)) throw new Error(`unexpected GET ${path}`);
      return answers[path];
    };

  const prove = (answers: Record<string, unknown>) =>
    proofFromPullRequestRun(PUSH, getFrom(answers));

  test('a synced squash merge whose run passed every job skips, naming its evidence', async () => {
    const proof = await prove(provenApi());

    expect(proof.proven).toBe(true);
    if (proof.proven) {
      expect(proof.evidence).toContain('#4');
      expect(proof.evidence).toContain(RUN_URL);
    }
  });

  test('a head identical to its base also proves', async () => {
    const answers = provenApi();
    answers[`compare/${PR_BASE}...${PR_HEAD}`] = { status: 'identical' };

    expect((await prove(answers)).proven).toBe(true);
  });

  test.each([
    [
      'a head that diverged from the base its run merged with',
      (answers: Record<string, unknown>) => {
        answers[`compare/${PR_BASE}...${PR_HEAD}`] = { status: 'diverged' };
      },
      'does not contain its base pr-base (diverged)',
    ],
    [
      'a pull request whose base was retargeted after its run',
      (answers: Record<string, unknown>) => {
        answers[EVENTS(1)] = [{ event: 'labeled' }, { event: 'base_ref_changed' }];
      },
      "#4's base was changed",
    ],
    [
      'a base change past the first page of events',
      (answers: Record<string, unknown>) => {
        answers[EVENTS(1)] = Array.from({ length: 100 }, () => ({ event: 'labeled' }));
        answers[EVENTS(2)] = [{ event: 'base_ref_changed' }];
      },
      "#4's base was changed",
    ],
    [
      'a head whose tree differs from the pushed tree',
      (answers: Record<string, unknown>) => {
        answers[`git/commits/${PR_HEAD}`] = { tree: { sha: 'tree-b' } };
      },
      'differ',
    ],
    [
      'a run that skipped a gated job (a prose-only pull request)',
      (answers: Record<string, unknown>) => {
        answers[JOBS] = {
          total_count: 2,
          jobs: [
            { name: 'changes', conclusion: 'success' },
            { name: 'test (windows-latest, packages)', conclusion: 'skipped' },
          ],
        };
      },
      'test (windows-latest, packages)=skipped',
    ],
    [
      'a run whose latest attempt failed a job',
      (answers: Record<string, unknown>) => {
        answers[JOBS] = {
          total_count: 1,
          jobs: [{ name: 'static', conclusion: 'failure' }],
        };
      },
      'static=failure',
    ],
    [
      'a run with more jobs than were read',
      (answers: Record<string, unknown>) => {
        answers[JOBS] = {
          total_count: 3,
          jobs: [{ name: 'changes', conclusion: 'success' }],
        };
      },
      '3 jobs, 1 read',
    ],
    [
      'a push no pull request was merged as (a direct push)',
      (answers: Record<string, unknown>) => {
        answers[`commits/${PUSH.head}/pulls`] = [
          { number: 3, merge_commit_sha: 'other', head: { sha: 'other-head' } },
        ];
      },
      'no pull request was merged as squash-commit',
    ],
    [
      'a head with no successful run',
      (answers: Record<string, unknown>) => {
        answers[
          `actions/workflows/test.yml/runs?head_sha=${PR_HEAD}&event=pull_request&status=success`
        ] = { workflow_runs: [] };
      },
      'no successful pull_request run of test.yml at pr-head',
    ],
    [
      'an API answer missing a field',
      (answers: Record<string, unknown>) => {
        answers[`git/commits/${PR_HEAD}`] = {};
      },
      'could not check pull request runs',
    ],
  ])('%s runs the suite', async (_case, change, reason) => {
    const answers = provenApi();
    change(answers);
    const proof = await prove(answers);

    expect(proof.proven).toBe(false);
    if (!proof.proven) expect(proof.reason).toContain(reason);
  });

  test('an API failure runs the suite and carries the cause', async () => {
    const proof = await proofFromPullRequestRun(PUSH, async path => {
      throw new Error(`GET ${path} answered 502`);
    });

    expect(proof).toEqual({
      proven: false,
      reason: `could not check pull request runs: GET commits/${PUSH.head}/pulls answered 502`,
    });
  });

  /**
   * The workflow's own path: the script reads the push event and asks a stub of the GitHub API.
   * The pushed commit only changes Markdown, so a decision that ignored the proof and followed
   * the diff would print `false` for the suite.
   */
  describe('the script', () => {
    const trackTempRoot = trackTempRoots();

    function docsOnlyPush(): { repo: string; before: string; after: string } {
      const repo = trackTempRoot(mkdtempSync(join(tmpdir(), 'run-suite-push-')));
      const git = (...args: string[]): string => {
        const r = Bun.spawnSync(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
        if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
        return r.stdout.toString().trim();
      };
      git('init', '-q', '-b', 'dev');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      const commit = (file: string): string => {
        writeFileSync(join(repo, file), `${file}\n`);
        git('add', file);
        git('commit', '-q', '-m', file);
        return git('rev-parse', 'HEAD');
      };
      const before = commit('seed.ts');
      return { repo, before, after: commit('GUIDE.md') };
    }

    async function runPush(
      answers: Record<string, unknown>,
      push: { repo: string; before: string; after: string },
      args: readonly string[] = []
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      const prefix = '/repos/owner/repo/';
      using server = Bun.serve({
        port: 0,
        fetch(request) {
          const url = new URL(request.url);
          const path = url.pathname.slice(prefix.length) + url.search;
          return path in answers
            ? Response.json(answers[path])
            : new Response('not found', { status: 404 });
        },
      });
      const eventDir = trackTempRoot(mkdtempSync(join(tmpdir(), 'run-suite-event-')));
      const eventPath = join(eventDir, 'event.json');
      writeFileSync(eventPath, JSON.stringify({ before: push.before, after: push.after }));
      // Async spawn: a synchronous one would block the stub server this test runs.
      const child = Bun.spawn(['bun', SCRIPT, ...args], {
        cwd: push.repo,
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: 'push',
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_TOKEN: 'test-token',
          GITHUB_REPOSITORY: 'owner/repo',
          GITHUB_API_URL: server.url.origin,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout: stdout.trim(), stderr };
    }

    test('a proven push skips the suite and logs its evidence', async () => {
      const push = docsOnlyPush();
      const result = await runPush(provenApi(push.after), push);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('false');
      expect(result.stderr).toContain(RUN_URL);
    });

    test('an unproven push runs the suite even when its diff is prose', async () => {
      const push = docsOnlyPush();
      const answers = provenApi(push.after);
      answers[`git/commits/${PR_HEAD}`] = { tree: { sha: 'tree-b' } };
      const result = await runPush(answers, push);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('true');
      expect(result.stderr).toContain('No pull request run proves this push');
    });
  });
});
