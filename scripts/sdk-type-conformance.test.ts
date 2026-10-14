import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { SDK_TYPE_EXCEPTIONS } from './sdk-type-exceptions';

const ROOT = resolve(import.meta.dir, '..');
const PROOF = join(ROOT, 'packages/providers/src/sdk-boundary-comparisons.ts');
const HELPERS = join(ROOT, 'packages/providers/src/sdk-type-conformance.type-test.ts');

function proofDiagnostics(
  extra = '',
  replacements: ReadonlyMap<string, string> = new Map()
): string[] {
  const comparisons = SDK_TYPE_EXCEPTIONS.flatMap((entry, index) => {
    if (entry.kind !== 'boundary') return [];
    const local = `Local${index}`;
    const sdk = `Sdk${index}`;
    const drift =
      entry.comparison === 'fields'
        ? `FieldDrift<${local}, ${sdk}>`
        : entry.comparison === 'sdk-subset'
          ? `Exclude<${sdk}, ${local}>`
          : `Exclude<${local}, ${sdk}>`;
    const localModule =
      './' +
      relative(join(ROOT, 'packages/providers/src'), join(ROOT, entry.file))
        .replaceAll('\\', '/')
        .replace(/\.(?:[cm]?ts|tsx)$/, '');
    return [
      `
import type { ${entry.name} as ${local} } from ${JSON.stringify(localModule)};
import type { ${entry.name} as ${sdk} } from ${JSON.stringify(entry.sdkModule)};
export type Comparison${index} = AssertNever<${drift}>;
`,
    ];
  }).join('\n');
  const proof = `
import type { AssertNever } from '@archon/provider-contract';
import type { FieldDrift } from './sdk-type-conformance.type-test';
${comparisons}
${extra}
`;
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
  host.readFile = file => (file === PROOF ? proof : (replacements.get(file) ?? readFile(file)));
  const program = ts.createProgram([PROOF, HELPERS], parsed.options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
}

test('SDK-free boundary types conform to the installed Claude and Pi declarations', () => {
  expect(proofDiagnostics()).toEqual([]);
});

test('conformance proof rejects a changed nested sandbox field', () => {
  const diagnostics = proofDiagnostics(`
import type { SandboxSettings as ClaudeSandboxSettings } from '@anthropic-ai/claude-agent-sdk';
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
    `import type { SandboxSettings as ClaudeSandboxSettings } from '@anthropic-ai/claude-agent-sdk';
import type { SandboxSettings } from '../../workflows/src/schemas/dag-node';
` + probes.map((probe, i) => `export type Broken${i} = ${probe};`).join('\n')
  );
  expect(diagnostics).toHaveLength(probes.length);
  for (const diagnostic of diagnostics)
    expect(diagnostic).toContain('does not satisfy the constraint');
});

test('generated comparison rejects drift in the actual ledgered sandbox schema', () => {
  const file = join(ROOT, 'packages/workflows/src/schemas/dag-node.ts');
  const original = readFileSync(file, 'utf8');
  const changed = original.replace(
    'ignoreViolations: z.record(z.string(), z.array(z.string())).optional()',
    'ignoreViolations: z.record(z.string(), z.array(z.number())).optional()'
  );
  expect(changed).not.toBe(original);
  expect(proofDiagnostics('', new Map([[file, changed]]))).toContainEqual(
    expect.stringContaining('does not satisfy the constraint')
  );
});
