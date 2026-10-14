import { expect, test } from 'bun:test';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { CONFORMANCE, SDK_TYPE_EXCEPTIONS } from './sdk-type-exceptions';

const ROOT = resolve(import.meta.dir, '..');
const PROOF = join(ROOT, CONFORMANCE);

function proofDiagnostics(extra = ''): string[] {
  const configPath = join(ROOT, 'packages/providers/tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error)
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    join(ROOT, 'packages/providers')
  );
  if (parsed.errors.length) throw new Error('Invalid providers tsconfig');
  const host = ts.createCompilerHost(parsed.options);
  const readFile = host.readFile;
  host.readFile = file => {
    const text = readFile(file);
    return file === PROOF && text !== undefined ? text + extra : text;
  };
  const program = ts.createProgram(
    [
      ...new Set(
        SDK_TYPE_EXCEPTIONS.flatMap(entry =>
          entry.kind === 'boundary' ? [join(ROOT, entry.conformanceTest)] : []
        )
      ),
    ],
    parsed.options,
    host
  );
  return ts
    .getPreEmitDiagnostics(program)
    .map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
}

test('SDK-free boundary types conform to the installed Claude and Pi declarations', () => {
  expect(proofDiagnostics()).toEqual([]);
});

test('conformance proof rejects a changed nested sandbox field', () => {
  const diagnostics = proofDiagnostics(`
export type BrokenSandbox = AssertNever<FieldDrift<{
  network?: { allowedDomains?: number[] };
}, ClaudeSandboxSettings>>;
`);
  expect(diagnostics).toEqual([expect.stringContaining('does not satisfy the constraint')]);
});

test('sandbox proof rejects dictionary value drift and null on every object field', () => {
  const fields = ['network', 'filesystem', 'ripgrep', 'ignoreViolations'];
  const probes = [
    ...fields.map(
      field =>
        `AssertNever<FieldDrift<{ ${field}?: SandboxSettings['${field}'] | null }, ClaudeSandboxSettings>>`
    ),
    'AssertNever<FieldDrift<{ ignoreViolations?: Record<string, number[]> }, ClaudeSandboxSettings>>',
  ];
  const diagnostics = proofDiagnostics(
    probes.map((probe, i) => `export type Broken${i} = ${probe};`).join('\n')
  );
  expect(diagnostics).toHaveLength(probes.length);
  for (const diagnostic of diagnostics)
    expect(diagnostic).toContain('does not satisfy the constraint');
});
