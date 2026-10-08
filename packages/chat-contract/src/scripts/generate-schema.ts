#!/usr/bin/env bun
/**
 * Regenerates packages/chat-contract/schema/chat-contract.schema.json from the
 * contract's zod schemas, so a chat plugin written in any language (a plugin binary) can
 * validate what it emits against the same shapes the engine parses.
 *
 * Usage:
 *   bun run src/scripts/generate-schema.ts          # write
 *   bun run src/scripts/generate-schema.ts --check  # verify (exit 2 if stale)
 */
import { readFile, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { z } from 'zod';
import { chatWireSchemas } from '../wire';
import { rpcMessageSchema } from '@archon/provider-contract/plugin';

const PACKAGE_ROOT = resolve(import.meta.dir, '../..');
const OUTPUT_PATH = join(PACKAGE_ROOT, 'schema/chat-contract.schema.json');
const CHECK_ONLY = process.argv.includes('--check');
const CONTRACT_SCHEMAS = { PluginRpcMessage: rpcMessageSchema, ...chatWireSchemas };

function render(): string {
  const registry = z.registry<{ id: string }>();
  for (const [id, schema] of Object.entries(CONTRACT_SCHEMAS)) registry.add(schema, { id });
  const { schemas } = z.toJSONSchema(registry, {
    // Zod appends a fragment to shared references; those definitions live in this document.
    uri: id => (id === '__shared' ? '' : `#/$defs/${id}`),
    // Describes what a chat plugin may emit: the engine's parse strips unknown keys, so the
    // published schema must not forbid them.
    io: 'input',
  });
  // One document; each schema's own `$id`/`$schema` would make its `$ref`s resolve per file.
  const defs = Object.fromEntries(
    Object.entries(schemas).map(([id, { $id: _id, $schema: _schema, ...schema }]) => [id, schema])
  );
  const shared = defs.__shared;
  delete defs.__shared;
  Object.assign(defs, shared?.$defs);
  const document = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $comment:
      'AUTO-GENERATED from packages/chat-contract/src by packages/chat-contract/src/scripts/generate-schema.ts. Do not edit.',
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
        'chat-contract.schema.json is stale.\nRun: bun run generate:chat-contract-schema (from the repository root)'
      );
      process.exit(2);
    }
    console.log('chat-contract.schema.json is up to date.');
    return;
  }
  await writeFile(OUTPUT_PATH, contents, 'utf-8');
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
