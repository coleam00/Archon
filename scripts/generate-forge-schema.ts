import { z } from 'zod';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  repoRefSchema,
  prRefSchema,
  pluginMetadataSchema,
  resolveRequestSchema,
  resolveResultSchema,
  checksStateRequestSchema,
  checksStateResultSchema,
  forgeOpErrorSchema,
  forgeHostsConfigSchema,
  forgeOpAuditEventSchema,
  forgeProcessFailureSchema,
  pinnedMergeRequestSchema,
  pinnedMergeResultSchema,
  mergeRecoverySchema,
  prRecordSchema,
  workItemRefSchema,
  publicRequestSchema,
  publicResultSchemas,
} from '@archon/forge';

const schemas = {
  PinnedMergeRequest: pinnedMergeRequestSchema,
  PinnedMergeResult: pinnedMergeResultSchema,
  MergeRecovery: mergeRecoverySchema,
  PrRecord: prRecordSchema,
  WorkItemRef: workItemRefSchema,
  PublicRequest: publicRequestSchema,
  ...publicResultSchemas,
  RepoRef: repoRefSchema,
  PrRef: prRefSchema,
  Metadata: pluginMetadataSchema,
  ResolveRequest: resolveRequestSchema,
  ResolveResult: resolveResultSchema,
  ChecksRequest: checksStateRequestSchema,
  ChecksResult: checksStateResultSchema,
  OpError: forgeOpErrorSchema,
  ProcessFailure: forgeProcessFailureSchema,
  HostsConfig: forgeHostsConfigSchema,
  Audit: forgeOpAuditEventSchema,
};
const output =
  JSON.stringify(
    Object.fromEntries(
      Object.entries(schemas).map(([name, schema]) => [name, z.toJSONSchema(schema)])
    ),
    null,
    2
  ) + '\n';
const path = resolve(import.meta.dir, '../packages/forge/wire-schema.json');
if (process.argv.includes('--check')) {
  if ((await readFile(path, 'utf8')).replace(/\r\n/g, '\n') !== output) {
    console.error('Forge wire schemas are stale; run bun run generate:forge-schema');
    process.exitCode = 1;
  }
} else await writeFile(path, output);
