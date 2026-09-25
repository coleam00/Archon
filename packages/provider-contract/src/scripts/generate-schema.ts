#!/usr/bin/env bun
/**
 * Regenerates packages/provider-contract/schema/provider-contract.schema.json from the
 * contract's zod schemas, so a provider written in any language (a plugin binary) can
 * validate what it emits against the same shapes the engine parses.
 *
 * Usage:
 *   bun run src/scripts/generate-schema.ts          # write
 *   bun run src/scripts/generate-schema.ts --check  # verify (exit 2 if stale)
 */
import { readFile, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { z } from 'zod';
import {
  providerCapabilitiesSchema,
  providerFailureSchema,
  providerResultSchema,
  resolvedModelSchema,
  tokenUsageSchema,
} from '../index';

const PACKAGE_ROOT = resolve(import.meta.dir, '../..');
const OUTPUT_PATH = join(PACKAGE_ROOT, 'schema/provider-contract.schema.json');
const CHECK_ONLY = process.argv.includes('--check');

/** Every schema a provider emits or declares, under the name its `$ref`s use. */
const CONTRACT_SCHEMAS = {
  ProviderFailure: providerFailureSchema,
  TokenUsage: tokenUsageSchema,
  ResolvedModel: resolvedModelSchema,
  ProviderResult: providerResultSchema,
  ProviderCapabilities: providerCapabilitiesSchema,
};

function render(): string {
  const registry = z.registry<{ id: string }>();
  for (const [id, schema] of Object.entries(CONTRACT_SCHEMAS)) registry.add(schema, { id });
  const { schemas } = z.toJSONSchema(registry, {
    uri: id => `#/$defs/${id}`,
    // Describes what a provider may emit: the engine's parse strips unknown keys, so the
    // published schema must not forbid them.
    io: 'input',
  });
  // One document; each schema's own `$id`/`$schema` would make its `$ref`s resolve per file.
  const defs = Object.fromEntries(
    Object.entries(schemas).map(([id, { $id: _id, $schema: _schema, ...schema }]) => [id, schema])
  );
  const document = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $comment:
      'AUTO-GENERATED from packages/provider-contract/src by packages/provider-contract/src/scripts/generate-schema.ts. Do not edit.',
    $defs: defs,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

async function main(): Promise<void> {
  const contents = render();
  if (CHECK_ONLY) {
    let existing = '';
    try {
      existing = (await readFile(OUTPUT_PATH, 'utf-8')).replace(/\r\n/g, '\n');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (existing !== contents) {
      console.error(
        'provider-contract.schema.json is stale.\nRun: bun run generate:provider-contract-schema (from the repository root)'
      );
      process.exit(2);
    }
    console.log('provider-contract.schema.json is up to date.');
    return;
  }
  await writeFile(OUTPUT_PATH, contents, 'utf-8');
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
