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
  replacements: ReadonlyMap<string, string> = new Map(),
  proofFile = PROOF
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
  // Core's subscription tokens are stored and refreshed as Pi OAuth credentials. Core cannot
  // import the Pi SDK and providers cannot import core, so this proof is where they meet.
  const proof = `
import type { AssertNever } from '@archon/provider-contract';
import type { OAuthCredentials as PiOAuthCredentials } from '@earendil-works/pi-ai/oauth';
import type { SubscriptionOAuthCredentials } from '../../core/src/credentials/subscription-oauth';
import type { FieldDrift } from './sdk-type-conformance.type-test';
export type SubscriptionTokenConformance = AssertNever<
  SubscriptionOAuthCredentials extends PiOAuthCredentials ? never : 'incompatible subscription tokens'
>;
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
  // The proof reads core and workflows sources, which are outside the providers project, so it
  // is checked as a plain program rather than as the composite project.
  const options = { ...parsed.options, composite: false };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile;
  const virtualSources = new Map(
    [...replacements, [proofFile, proof] as const].map(([file, text]) => [
      file.replaceAll('\\', '/'),
      text,
    ])
  );
  host.readFile = file => virtualSources.get(file.replaceAll('\\', '/')) ?? readFile(file);
  const program = ts.createProgram([proofFile, HELPERS], options, host);
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
import type { SandboxSettings } from '../../workflows/src/schemas/provider-options';
` + probes.map((probe, i) => `export type Broken${i} = ${probe};`).join('\n')
  );
  expect(diagnostics).toHaveLength(probes.length);
  for (const diagnostic of diagnostics)
    expect(diagnostic).toContain('does not satisfy the constraint');
});

test('generated comparison rejects drift in the actual ledgered sandbox schema', () => {
  const file = join(ROOT, 'packages/workflows/src/schemas/provider-options.ts');
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

test('compiler host supplies virtual sources with Windows path separators', () => {
  const proofFile = PROOF.replaceAll('/', '\\');
  expect(proofDiagnostics('', new Map(), proofFile)).toEqual([]);
});

test('compiler host applies replacements with Windows path separators', () => {
  const file = join(ROOT, 'packages/workflows/src/schemas/effort.ts');
  const original = readFileSync(file, 'utf8');
  const changed = original.replace(
    'export type EffortLevel = z.infer<typeof effortLevelSchema>;',
    "export type EffortLevel = Extract<z.infer<typeof effortLevelSchema>, 'low'>;"
  );
  expect(changed).not.toBe(original);
  expect(proofDiagnostics('', new Map([[file.replaceAll('/', '\\'), changed]]))).toContainEqual(
    expect.stringContaining('does not satisfy the constraint')
  );
});

for (const probe of [
  {
    name: 'OAuthCredentials',
    file: 'packages/core/src/credentials/delivery.ts',
    original: 'export type OAuthCredentials = Record<string, unknown>;',
    changed: 'export type OAuthCredentials = Record<string, string>;',
  },
  {
    name: 'EffortLevel',
    file: 'packages/workflows/src/schemas/effort.ts',
    original: 'export type EffortLevel = z.infer<typeof effortLevelSchema>;',
    changed: "export type EffortLevel = Extract<z.infer<typeof effortLevelSchema>, 'low'>;",
  },
  {
    name: 'OAuthLoginCallbacks',
    file: 'packages/core/src/credentials/subscription-oauth.ts',
    original: 'onAuth(info: OAuthAuthInfo): void;',
    changed: 'onAuth(info: number): void;',
  },
]) {
  test(`generated subset comparison rejects incompatible ${probe.name}`, () => {
    const file = join(ROOT, probe.file);
    const original = readFileSync(file, 'utf8');
    const changed = original.replace(probe.original, probe.changed);
    expect(changed).not.toBe(original);
    expect(proofDiagnostics('', new Map([[file, changed]]))).toContainEqual(
      expect.stringContaining('does not satisfy the constraint')
    );
  });
}
