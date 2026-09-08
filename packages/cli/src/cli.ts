#!/usr/bin/env bun
// Strip Bun's ambient .env before either route initializes modules that read env.
import '@archon/paths/strip-cwd-env-boot';
import { withDrainedExit } from './utils/exit-with-drain';

async function main(): Promise<number> {
  // A re-entered operation inherits the host's selected credential environment.
  // Reloading files could restore a token the workflow host deliberately scrubbed.
  if (!process.env.ARCHON_EXECUTABLE && process.argv[3] !== '__github') {
    const { loadArchonEnv } = await import('@archon/paths/env-loader');
    loadArchonEnv(process.cwd());
  }
  const { forgeCommand } = await import('./commands/forge');
  return forgeCommand(process.argv.slice(3));
}

if (process.argv[2] === 'forge') {
  withDrainedExit(main);
} else {
  // Preserve all existing non-forge initialization and exit ordering in one module.
  await import('./cli-main');
}
