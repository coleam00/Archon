import { resolve } from 'node:path';
import { BUNDLED_IS_BINARY } from '@archon/paths';

export function cliProgramArguments(): [string, ...string[]] {
  return BUNDLED_IS_BINARY ? [process.execPath] : [process.execPath, resolve(process.argv[1])];
}
