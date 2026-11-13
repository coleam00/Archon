import { setPlatformPolicies } from '@archon/core/platforms/registry';
import { writeFileSync } from 'node:fs';
import { createSqlWorkflowHost } from '@archon/core/workflows/sql-host';
import { startAdmittedResourceStart } from '@archon/core/workflows/resource-start-host';
import { HeadlessPlatform } from '@archon/core/workflows/headless-platform';
import { registerBuiltinProviders, registerCommunityProviders } from '@archon/providers/in-process';
import { triggerCommand } from '../../commands/trigger';

const [config, readyFile, hostId] = process.argv.slice(2);
if (!config || !readyFile || !hostId) throw new Error('Missing fixture arguments');
setPlatformPolicies([]);
registerBuiltinProviders();
registerCommunityProviders();
const host = createSqlWorkflowHost();
const admitted: string[] = [];
const dispatch = async (id: string): Promise<void> => {
  admitted.push(id);
};
await triggerCommand(host, 'fire', [], { config }, { dispatch });
await triggerCommand(host, 'fire', [], { config }, { dispatch });
const [requestId] = admitted;
if (admitted.length !== 1 || !requestId)
  throw new Error('Expected one admitted and one queued start');
host.deps.loadConfig = async () => {
  writeFileSync(readyFile, JSON.stringify({ requestId }));
  return await new Promise<never>(() => {
    // Only killing this process releases the held preparation.
  });
};
await startAdmittedResourceStart({
  requestId,
  hostId,
  host,
  createPlatform: () => new HeadlessPlatform(),
});
throw new Error('Held preparation unexpectedly returned');
