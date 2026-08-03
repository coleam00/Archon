#!/usr/bin/env bun
/**
 * Regenerates packages/providers/src/community/pi/pi-vendor-map.generated.ts
 * from the installed `@earendil-works/pi-ai` SDK (#1955).
 *
 * Why: the Pi runtime's backend → env-var map and the connectable-credential
 * catalog must stay in lockstep with pi-ai's `env-api-keys` module. Previous
 * hand-maintained copies (delivery.ts + pi/provider.ts) drifted — Archon
 * delivered HUGGINGFACE_API_KEY while pi-ai reads HF_TOKEN. Generating from
 * the installed SDK makes that class of bug a CI failure instead.
 *
 * Sources (inside node_modules/@earendil-works/pi-ai/dist):
 *   - env-api-keys.js      — the provider → env-var map (parsed from source;
 *     the map is module-private so it cannot be imported)
 *   - models.generated.js  — the static model catalog (provider id totality
 *     check: a new upstream backend fails the check until classified here)
 *
 * Usage:
 *   bun run scripts/generate-pi-vendor-map.ts          # write
 *   bun run scripts/generate-pi-vendor-map.ts --check  # verify (exit 2 if stale)
 *
 * Exit codes:
 *   0  file generated (and unchanged, if --check)
 *   1  unexpected error (SDK missing, parse failure, unclassified provider)
 *   2  --check was passed and the file would change
 */
import { readFile, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..');
// Resolve pi-ai from the package that depends on it — it may not be hoisted
// to the repo-root node_modules (Bun workspace layout varies).
const PI_AI_DIST = dirname(
  Bun.resolveSync('@earendil-works/pi-ai', join(REPO_ROOT, 'packages/providers'))
);
const OUTPUT_PATH = join(
  REPO_ROOT,
  'packages/providers/src/community/pi/pi-vendor-map.generated.ts'
);
const CHECK_ONLY = process.argv.includes('--check');

/** Vendors handled by explicit branches in pi-ai's getApiKeyEnvVars (not the envMap). */
const SPECIAL_ENV_VENDORS: Record<string, string> = {
  // ANTHROPIC_OAUTH_TOKEN takes precedence upstream, but the api_key delivery
  // path sets the plain key var; subscriptions reach Pi via auth.json instead.
  anthropic: 'ANTHROPIC_API_KEY',
  'github-copilot': 'COPILOT_GITHUB_TOKEN',
};

/** Vendors whose credentials are ambient cloud chains, not pasteable keys. */
const AMBIENT_VENDORS = new Set(['amazon-bedrock', 'google-vertex']);

/**
 * Catalog provider ids that intentionally produce NO credential spec of their
 * own. `openai-codex` is the ChatGPT-subscription backend — its credential is
 * vendor `openai` kind `subscription` (delivery via auth.json), not a separate
 * vendor.
 */
const COVERED_ELSEWHERE = new Set(['openai-codex']);

/**
 * Vendors that support subscription (OAuth) login in addition to API keys.
 * All three are connectable: anthropic and github-copilot log in via Pi's
 * OAuth flows; `openai` (ChatGPT/Codex) via Archon's own PKCE flow
 * (@archon/core credentials/openai-oauth.ts — it captures the `id_token` Pi
 * drops, #1924). Specs declare capability; `SUBSCRIPTION_PROVIDERS` in
 * @archon/core oauth-providers is the runtime source of truth.
 */
const SUBSCRIPTION_VENDORS = new Set(['anthropic', 'openai', 'github-copilot']);

/** Human display names. Fallback: title-case each dash token. */
const DISPLAY_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google Gemini',
  'google-vertex': 'Google Vertex AI',
  groq: 'Groq',
  mistral: 'Mistral',
  cerebras: 'Cerebras',
  xai: 'xAI',
  openrouter: 'OpenRouter',
  huggingface: 'Hugging Face',
  deepseek: 'DeepSeek',
  fireworks: 'Fireworks AI',
  together: 'Together AI',
  zai: 'Z.AI',
  minimax: 'MiniMax',
  'minimax-cn': 'MiniMax (CN)',
  moonshotai: 'Moonshot AI',
  'moonshotai-cn': 'Moonshot AI (CN)',
  'kimi-coding': 'Kimi Coding',
  'azure-openai-responses': 'Azure OpenAI',
  'vercel-ai-gateway': 'Vercel AI Gateway',
  'cloudflare-workers-ai': 'Cloudflare Workers AI',
  'cloudflare-ai-gateway': 'Cloudflare AI Gateway',
  opencode: 'OpenCode Zen',
  'opencode-go': 'OpenCode Zen (Go)',
  xiaomi: 'Xiaomi',
  'xiaomi-token-plan-cn': 'Xiaomi Token Plan (CN)',
  'xiaomi-token-plan-ams': 'Xiaomi Token Plan (AMS)',
  'xiaomi-token-plan-sgp': 'Xiaomi Token Plan (SGP)',
  'github-copilot': 'GitHub Copilot',
  'amazon-bedrock': 'Amazon Bedrock',
};

function displayName(vendor: string): string {
  return (
    DISPLAY_NAMES[vendor] ??
    vendor
      .split('-')
      .map(t => t.charAt(0).toUpperCase() + t.slice(1))
      .join(' ')
  );
}

/**
 * Extract pi-ai's module-private `envMap` object literal from source. Parsed
 * with a strict entry regex (no eval): every non-blank line inside the literal
 * must match `key: "ENV_VAR",` — anything else is an upstream shape change and
 * fails loud.
 */
function parseEnvMap(source: string): Record<string, string> {
  const match = /const envMap = \{([\s\S]*?)\};/.exec(source);
  if (!match?.[1]) {
    throw new Error(
      'Could not locate `const envMap = {...}` in pi-ai env-api-keys.js — upstream shape changed; update this generator.'
    );
  }
  const entryRe = /^\s*(?:"([^"]+)"|([A-Za-z0-9_$]+)):\s*"([^"]+)",?\s*$/;
  const parsed: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    if (!line.trim()) continue;
    const entry = entryRe.exec(line);
    const key = entry?.[1] ?? entry?.[2];
    const value = entry?.[3];
    if (!key || !value) {
      throw new Error(
        `Unparseable envMap line in pi-ai env-api-keys.js: ${line.trim()} — upstream shape changed; update this generator.`
      );
    }
    parsed[key] = value;
  }
  if (Object.keys(parsed).length === 0) {
    throw new Error('Parsed pi-ai envMap is empty — upstream shape changed.');
  }
  return parsed;
}

/** Assert the special-case branches this generator hardcodes still exist upstream. */
function assertSpecialCases(source: string): void {
  const markers = [
    '"github-copilot"',
    'COPILOT_GITHUB_TOKEN',
    'ANTHROPIC_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    '"google-vertex"',
    '"amazon-bedrock"',
  ];
  for (const marker of markers) {
    if (!source.includes(marker)) {
      throw new Error(
        `pi-ai env-api-keys.js no longer contains ${marker} — special-case handling drifted; update this generator.`
      );
    }
  }
}

async function main(): Promise<void> {
  const envApiKeysSource = await readFile(join(PI_AI_DIST, 'env-api-keys.js'), 'utf-8');
  assertSpecialCases(envApiKeysSource);
  const envMap = parseEnvMap(envApiKeysSource);

  const modelsModule = (await import(join(PI_AI_DIST, 'models.generated.js'))) as Record<
    string,
    unknown
  >;
  // Prefer the aggregate MODELS export (provider id → models map) when present;
  // otherwise fall back to per-provider named exports.
  const aggregate =
    typeof modelsModule.MODELS === 'object' && modelsModule.MODELS !== null
      ? (modelsModule.MODELS as Record<string, unknown>)
      : modelsModule;
  const catalogIds = Object.keys(aggregate)
    .filter(k => typeof aggregate[k] === 'object' && aggregate[k] !== null)
    .sort();
  if (catalogIds.length === 0) {
    throw new Error('pi-ai models.generated.js exported no providers — upstream shape changed.');
  }

  // Full env-var map: envMap + the special-case branches.
  const envVars: Record<string, string> = { ...SPECIAL_ENV_VENDORS };
  for (const [vendor, envVar] of Object.entries(envMap)) {
    envVars[vendor] = envVar;
  }

  // Totality: every catalog provider must be classified somewhere.
  const unclassified = catalogIds.filter(
    id => !(id in envVars) && !AMBIENT_VENDORS.has(id) && !COVERED_ELSEWHERE.has(id)
  );
  if (unclassified.length > 0) {
    throw new Error(
      `New pi-ai catalog providers are unclassified: ${unclassified.join(', ')}. ` +
        'Classify them in scripts/generate-pi-vendor-map.ts (env-key vendor, ambient, or covered-elsewhere).'
    );
  }

  const sortedVendors = Object.keys(envVars).sort();

  const keySpecs = sortedVendors.map(vendor => ({
    vendor,
    displayName: displayName(vendor),
    kinds: [
      'api_key',
      ...(SUBSCRIPTION_VENDORS.has(vendor) ? ['subscription'] : []),
      ...(AMBIENT_VENDORS.has(vendor) ? ['ambient'] : []),
    ],
  }));
  // Ambient-only vendors (no pasteable key, absent from the env map).
  const ambientOnlySpecs = [...AMBIENT_VENDORS]
    .filter(vendor => !(vendor in envVars))
    .map(vendor => ({ vendor, displayName: displayName(vendor), kinds: ['ambient'] }));
  const specs = [...keySpecs, ...ambientOnlySpecs].sort((a, b) => a.vendor.localeCompare(b.vendor));

  const envVarLines = sortedVendors
    .map(vendor => `  ${JSON.stringify(vendor)}: ${JSON.stringify(envVars[vendor])},`)
    .join('\n');

  const specLines = specs
    .map(
      s =>
        `  { vendor: ${JSON.stringify(s.vendor)}, displayName: ${JSON.stringify(s.displayName)}, kinds: [${s.kinds.map(k => JSON.stringify(k)).join(', ')}] },`
    )
    .join('\n');

  const contents = [
    '/**',
    ' * AUTO-GENERATED — DO NOT EDIT.',
    ' *',
    ' * Regenerate with: bun run generate:pi-vendor-map',
    ' * Verify up-to-date: bun run check:pi-vendor-map',
    ' *',
    ' * Source of truth: the installed @earendil-works/pi-ai SDK',
    ' * (dist/env-api-keys.js + dist/models.generated.js).',
    ' *',
    ' * Single source for (a) the Pi runtime env-var bridge and (b) the',
    ' * connectable-credential specs in the Pi provider registration. A pi-ai',
    ' * upgrade that adds/renames backends fails `bun run validate` until this',
    ' * file is regenerated (and any new backend is classified in the generator).',
    ' */',
    "import type { CredentialSpec } from '../../types';",
    '',
    '/**',
    ' * Pi backend vendor id → the env var pi-ai reads for its API key',
    " * (and the var Archon's per-user delivery sets).",
    ' */',
    'export const PI_PROVIDER_ENV_VARS: Record<string, string> = {',
    envVarLines,
    '};',
    '',
    '/** Vendors authenticated via ambient cloud credential chains (status-only). */',
    `export const PI_AMBIENT_VENDORS: readonly string[] = ${JSON.stringify([...AMBIENT_VENDORS].sort())};`,
    '',
    '/** Credential specs for the Pi provider registration (consumption matrix). */',
    'export const PI_CREDENTIAL_SPECS: CredentialSpec[] = [',
    specLines,
    '];',
    '',
  ].join('\n');

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
        'pi-vendor-map.generated.ts is stale vs the installed pi-ai SDK.\nRun: bun run generate:pi-vendor-map'
      );
      process.exit(2);
    }
    console.log('check:pi-vendor-map OK');
    return;
  }

  await writeFile(OUTPUT_PATH, contents, 'utf-8');
  console.log(
    `Generated ${OUTPUT_PATH} (${sortedVendors.length} key vendors, ${specs.length} specs)`
  );
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
