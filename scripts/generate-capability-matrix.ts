#!/usr/bin/env bun
/**
 * Regenerates the canonical provider capability matrix docs page
 * (packages/docs-web/src/content/docs/reference/provider-capabilities.md)
 * from the registered providers' `capabilities.ts` constants (#2116).
 *
 * Why: provider capability documentation was hand-maintained in several
 * surfaces (CLAUDE.md, the docs-web assistant guides, the archon skill) and
 * each independently drifted from packages/providers/src/*\/capabilities.ts.
 * The 2026-07-14 audits found the same error class everywhere (providers
 * under/over-claiming per-node mcp / tool restrictions / skills / agents /
 * hooks). Generating one canonical table from the registry's capability
 * constants — the SAME objects the dag-executor reads to decide its
 * ignored-capability warnings — makes a capability change a `bun run validate`
 * failure until the docs are regenerated.
 *
 * Source of truth: the provider registry (registerBuiltinProviders +
 * registerCommunityProviders → getProviderInfoList). The factories stay lazy,
 * so no provider is instantiated; we only read the static capability metadata.
 *
 * Usage:
 *   bun run scripts/generate-capability-matrix.ts          # write
 *   bun run scripts/generate-capability-matrix.ts --check  # verify (exit 2 if stale)
 *
 * Exit codes:
 *   0  file generated (and unchanged, if --check)
 *   1  unexpected error (uncovered capability axis, registry failure)
 *   2  --check was passed and the file would change
 */
import { readFile, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import {
  registerBuiltinProviders,
  registerCommunityProviders,
  getProviderInfoList,
} from '@archon/providers';
import type { ProviderCapabilities, ProviderInfo } from '@archon/providers';

const REPO_ROOT = resolve(import.meta.dir, '..');
const OUTPUT_PATH = join(
  REPO_ROOT,
  'packages/docs-web/src/content/docs/reference/provider-capabilities.md'
);
const CHECK_ONLY = process.argv.includes('--check');

/**
 * Ordered rows of the matrix. `key` is the `ProviderCapabilities` field, so a
 * renamed/removed field is a compile error here. The totality guard below fails
 * loudly if a NEW capability field is added to the type without an axis, so the
 * matrix can never silently omit a capability.
 */
const AXES: readonly { key: keyof ProviderCapabilities; label: string }[] = [
  { key: 'sessionResume', label: 'Session resume' },
  { key: 'mcp', label: 'MCP servers (`mcp:`)' },
  { key: 'hooks', label: 'Hooks (`hooks:`)' },
  { key: 'skills', label: 'Skills (`skills:`)' },
  { key: 'agents', label: 'Inline sub-agents (`agents:`)' },
  { key: 'toolRestrictions', label: 'Tool restrictions (`allowed_tools`/`denied_tools`)' },
  { key: 'structuredOutput', label: 'Structured output (`output_format`)' },
  { key: 'envInjection', label: 'Env injection (`env:`)' },
  { key: 'costControl', label: 'Cost control (`maxBudgetUsd`)' },
  { key: 'effortControl', label: 'Effort control (`effort`)' },
  { key: 'thinkingControl', label: 'Thinking control (`thinking`)' },
  { key: 'fallbackModel', label: 'Fallback model (`fallbackModel`)' },
  { key: 'sandbox', label: 'Sandbox (`sandbox`)' },
  { key: 'settingSources', label: 'Setting sources (`settingSources`)' },
  { key: 'nativeTools', label: 'In-process native tools' },
  { key: 'containerExec', label: 'Container exec (folder-project container backend)' },
];

/**
 * Capability keys intentionally excluded from the matrix: advisory tool-name
 * vocabulary, not a supported/unsupported axis. Listed so the totality guard
 * treats them as covered rather than flagging them as a missing axis.
 */
const SKIP_KEYS = new Set<keyof ProviderCapabilities>(['knownToolNames', 'renamedTools']);

/** Render a single provider's value for an axis. */
function renderCell(caps: ProviderCapabilities, key: keyof ProviderCapabilities): string {
  if (key === 'structuredOutput') {
    const tier = caps.structuredOutput;
    if (tier === 'enforced') return '**enforced**';
    if (tier === 'best-effort') return 'best-effort';
    return '❌';
  }
  return caps[key] ? '✅' : '❌';
}

/**
 * Fail loudly if a provider declares a capability key the matrix neither
 * renders nor explicitly skips — i.e. someone added a field to
 * `ProviderCapabilities` without giving it a matrix axis.
 */
function assertTotalCoverage(providers: ProviderInfo[]): void {
  const covered = new Set<string>([...AXES.map(a => a.key), ...SKIP_KEYS]);
  const uncovered = new Set<string>();
  for (const p of providers) {
    for (const key of Object.keys(p.capabilities)) {
      if (!covered.has(key)) uncovered.add(key);
    }
  }
  if (uncovered.size > 0) {
    throw new Error(
      `ProviderCapabilities field(s) not represented in the capability matrix: ${[...uncovered].join(', ')}. ` +
        'Add an axis in scripts/generate-capability-matrix.ts (or add to SKIP_KEYS if advisory-only).'
    );
  }
}

function buildMarkdown(providers: ProviderInfo[]): string {
  const ids = providers.map(p => p.id);

  const providerList = providers
    .map(p => `- \`${p.id}\` — ${p.displayName}${p.builtIn ? '' : ' *(community provider)*'}`)
    .join('\n');

  const header = `| Capability | ${ids.map(id => `\`${id}\``).join(' | ')} |`;
  const divider = `|${' --- |'.repeat(ids.length + 1)}`;
  const rows = AXES.map(axis => {
    const cells = providers.map(p => renderCell(p.capabilities, axis.key));
    return `| ${axis.label} | ${cells.join(' | ')} |`;
  }).join('\n');

  return [
    '---',
    'title: Provider Capability Matrix',
    'description: Canonical per-provider capability matrix, generated from each provider capabilities.ts.',
    'category: reference',
    'area: clients',
    'audience: [user, developer]',
    'status: current',
    'sidebar:',
    '  order: 10',
    '---',
    '',
    '<!-- AUTO-GENERATED — DO NOT EDIT. Regenerate with: bun run generate:capability-matrix -->',
    '',
    ':::note',
    "This page is **auto-generated** from each provider's `capabilities.ts` (the same",
    'constants the workflow engine reads to warn when a node uses a feature its',
    'provider ignores). Do not edit it by hand — run `bun run generate:capability-matrix`.',
    'A capability change fails `bun run validate` until this page is regenerated.',
    ':::',
    '',
    'Each column is a registered provider id (the value you set as `provider:` in a',
    'workflow or `.archon/config.yaml`). A ✅ means Archon translates the corresponding',
    'per-node YAML field for that provider; a ❌ means the field is accepted but ignored',
    '(the dag-executor emits a visible warning when the run reaches such a node).',
    '',
    '## Providers',
    '',
    providerList,
    '',
    '## Capabilities',
    '',
    header,
    divider,
    rows,
    '',
    '## Legend',
    '',
    '- **✅ / ❌** — the per-node field is wired for this provider, or accepted-but-ignored.',
    '- **Structured output** — `enforced` (the SDK/backend grammar-constrains decoding),',
    '  `best-effort` (schema appended to the prompt, then validated + re-asked up to 3×),',
    '  or ❌ (unsupported). See [AI Assistants → Structured output guarantees](/getting-started/ai-assistants/#structured-output-guarantees).',
    '- **In-process native tools** — the provider can register Archon `NativeTool`s for a',
    "  turn (gates auto-injection of Archon's `manage_run` tool into project-scoped chat).",
    '',
    'For per-provider field-level notes (YAML syntax, caveats), see the',
    '[AI Assistants guide](/getting-started/ai-assistants/).',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  registerBuiltinProviders();
  registerCommunityProviders();
  const providers = getProviderInfoList();
  if (providers.length === 0) {
    throw new Error('No providers registered — registry bootstrap failed.');
  }
  assertTotalCoverage(providers);

  const contents = buildMarkdown(providers);

  if (CHECK_ONLY) {
    let existing = '';
    try {
      existing = (await readFile(OUTPUT_PATH, 'utf-8')).replace(/\r\n/g, '\n');
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') throw err;
    }
    if (existing !== contents) {
      console.error(
        "provider-capabilities.md is stale vs the providers' capabilities.ts.\nRun: bun run generate:capability-matrix"
      );
      process.exit(2);
    }
    console.log('check:capability-matrix OK');
    return;
  }

  await writeFile(OUTPUT_PATH, contents, 'utf-8');
  console.log(`Generated ${OUTPUT_PATH} (${providers.length} providers, ${AXES.length} axes)`);
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
