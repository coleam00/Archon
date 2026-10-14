import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { gitOutput } from './check-test-cleanup-drift';
import { CONFORMANCE, SDK_TYPE_EXCEPTIONS, type SdkTypeException } from './sdk-type-exceptions';

const REPO_ROOT = resolve(import.meta.dir, '..');
const SDK_PACKAGES = [
  '@anthropic-ai/claude-agent-sdk',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-coding-agent',
  '@github/copilot-sdk',
  '@opencode-ai/sdk',
];

export type SdkTypeNames = ReadonlyMap<string, readonly string[]>;

function typeTargets(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, target]) =>
    key === 'types' && typeof target === 'string' ? [target] : typeTargets(target)
  );
}

export function installedSdkTypes(root = REPO_ROOT): SdkTypeNames {
  const entries = new Map<string, string[]>();
  for (const sdk of SDK_PACKAGES) {
    const directory = [
      join(root, 'packages/providers/node_modules', sdk),
      join(root, 'node_modules', sdk),
    ].find(path => existsSync(join(path, 'package.json')));
    if (directory === undefined)
      throw new Error(`Missing installed SDK ${sdk}; run bun install --frozen-lockfile`);
    const manifest: { exports?: unknown; types?: unknown } = JSON.parse(
      readFileSync(join(directory, 'package.json'), 'utf8')
    );
    const targets = typeTargets(manifest.exports);
    if (typeof manifest.types === 'string') targets.push(manifest.types);
    const paths = targets.flatMap(target =>
      target.includes('*')
        ? [...new Bun.Glob(target).scanSync({ cwd: directory, absolute: true })]
        : [join(directory, target)]
    );
    if (paths.length === 0) throw new Error(`No type declarations found for ${sdk}`);
    for (const path of new Set(paths)) {
      if (!existsSync(path)) throw new Error(`Missing SDK type declaration: ${path}`);
      entries.set(path, [...(entries.get(path) ?? []), sdk]);
    }
  }
  const program = ts.createProgram([...entries.keys()], {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const names = new Map<string, string[]>();
  for (const [path, sdks] of entries) {
    const source = program.getSourceFile(path);
    const module = source === undefined ? undefined : checker.getSymbolAtLocation(source);
    if (module === undefined) throw new Error(`Cannot read SDK exports: ${path}`);
    for (const exported of checker.getExportsOfModule(module)) {
      const symbol =
        exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      if (!(symbol.flags & ts.SymbolFlags.Type)) continue;
      const name = exported.name;
      names.set(name, [...new Set([...(names.get(name) ?? []), ...sdks])]);
    }
  }
  return names;
}

export function isCheckedSource(file: string): boolean {
  // Codex ships a CLI, not importable SDK declarations. Its generated app-server protocol is
  // owned by generate:codex-protocol and intentionally excluded along with the provider package.
  return /\.(?:[cm]?ts|tsx)$/.test(file) && !file.startsWith('packages/providers/');
}

export function checkSources(
  sources: ReadonlyMap<string, string>,
  sdkTypes: SdkTypeNames,
  ledger: readonly SdkTypeException[] = SDK_TYPE_EXCEPTIONS
): string[] {
  const failures: string[] = [];
  const collisions = new Map<string, number>();
  for (const [file, text] of sources) {
    if (!isCheckedSource(file)) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node): void {
      if (
        (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
        sdkTypes.has(node.name.text)
      ) {
        const name = node.name.text;
        const key = `${file}:${name}`;
        const line = source.getLineAndCharacterOfPosition(node.name.getStart(source)).line + 1;
        collisions.set(key, (collisions.get(key) ?? 0) + 1);
        if (!ledger.some(entry => entry.file === file && entry.name === name)) {
          failures.push(
            `${file}:${line} ${name} matches an exported type of ${sdkTypes.get(name)?.join(', ')}; import it or record a justified SDK_TYPE_EXCEPTIONS entry`
          );
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  const recorded = new Set<string>();
  for (const entry of ledger) {
    const key = `${entry.file}:${entry.name}`;
    if (recorded.has(key)) failures.push(`${key}: duplicate SDK type ledger entry`);
    recorded.add(key);
    if (!entry.reason.trim()) failures.push(`${key}: SDK type ledger entry needs a reason`);
    if (!collisions.has(key)) failures.push(`${key}: stale SDK type ledger entry; remove it`);
    if ((collisions.get(key) ?? 0) > 1)
      failures.push(`${key}: multiple declarations cannot share one ledger entry`);
    if (entry.kind === 'boundary') {
      if (entry.conformanceTest !== CONFORMANCE) {
        failures.push(`${key}: boundary comparisons must use ${CONFORMANCE}`);
      } else if (!sources.has(CONFORMANCE)) {
        failures.push(`${key}: conformance test does not exist: ${CONFORMANCE}`);
      }
      if (
        !sdkTypes
          .get(entry.name)
          ?.some(sdk => entry.sdkModule === sdk || entry.sdkModule.startsWith(`${sdk}/`))
      ) {
        failures.push(`${key}: comparison must import this type from its installed SDK owner`);
      }
    }
  }
  return failures;
}

export function checkRepository(root = REPO_ROOT): string[] {
  const files = gitOutput(
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    root
  ).split('\0');
  const sources = new Map<string, string>();
  for (const file of files) {
    if (isCheckedSource(file) && existsSync(join(root, file)))
      sources.set(file, readFileSync(join(root, file), 'utf8'));
  }
  return checkSources(sources, installedSdkTypes(root));
}

if (import.meta.main) {
  const failures = checkRepository();
  if (failures.length > 0) {
    console.error(
      ['SDK type drift detected:', ...failures.map(failure => `  ${failure}`)].join('\n')
    );
    process.exit(1);
  }
  console.log('SDK type drift check passed.');
}
