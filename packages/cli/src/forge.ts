#!/usr/bin/env bun
import { spawn } from 'child_process';
import { findRepoRoot, getRemoteUrl, resolveForgeContext } from '@archon/git';

function printForgeUsage(): void {
  console.error('Usage: archon-forge <args...>');
  console.error('Example: archon-forge issue view 123');
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    printForgeUsage();
    return 1;
  }

  let remoteUrl: string | null = null;
  const cwd = process.cwd();

  const repoRoot = await findRepoRoot(cwd);
  if (repoRoot) {
    remoteUrl = await getRemoteUrl(repoRoot);
  }

  const forge = resolveForgeContext({ remoteUrl, env: process.env });
  const cli = process.env.FORGE_CLI?.trim() || forge.cli;

  if (!cli) {
    const detected = forge.type === 'unknown' ? 'unknown forge' : forge.type;
    console.error(`Unable to determine forge CLI for ${detected}.`);
    console.error(
      'Set FORGE_CLI to gh or glab, or run from a repository with a known origin remote.'
    );
    return 1;
  }

  return await new Promise<number>(resolve => {
    const child = spawn(cli, args, {
      stdio: 'inherit',
      env: process.env,
    });

    child.on('error', err => {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        console.error(`Forge CLI not found: ${cli}`);
        console.error(`Install ${cli} or set FORGE_CLI to an available executable.`);
      } else {
        console.error(`Failed to execute ${cli}: ${error.message}`);
      }
      resolve(1);
    });

    child.on('close', code => {
      resolve(code ?? 1);
    });
  });
}

main()
  .then(code => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    const err = error as Error;
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
  });
