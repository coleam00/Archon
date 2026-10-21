import { parseArgs } from 'node:util';
import { CHAT_PROJECT_ID_ARG } from '@archon/paths/workflow-scope';
import { cliArgOptions } from './args';

const startupArgs = process.argv.slice(2);

export function readChatProjectScope(): string | undefined {
  const { values } = parseArgs({
    args: startupArgs,
    options: cliArgOptions,
    allowPositionals: true,
    strict: false,
  });
  const scope = values[CHAT_PROJECT_ID_ARG];
  return typeof scope === 'string' ? scope : undefined;
}
