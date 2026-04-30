#!/usr/bin/env bun
/**
 * Thin Bun entrypoint for running the Symphony service standalone (no Archon
 * HTTP server). Used for the Phase 2 manual smoke test:
 *
 *   bun packages/symphony/src/cli/dev.ts ~/.archon/symphony.yaml
 *
 * Phase 3 will wire `startSymphonyService` into the Archon server process so
 * this entrypoint becomes optional.
 */
import { startSymphonyService } from '../service';

async function main(): Promise<void> {
  const argPath = process.argv[2];
  const envPath = process.env.SYMPHONY_CONFIG;
  const configPath = argPath ?? envPath;

  const handle = await startSymphonyService(configPath ? { configPath } : {});

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`\n[symphony] received ${signal}, stopping...\n`);
    try {
      await handle.stop();
    } catch (e) {
      process.stderr.write(`[symphony] stop failed: ${(e as Error).message}\n`);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e: unknown) => {
  process.stderr.write(`[symphony] fatal: ${(e as Error).message}\n`);
  process.exit(1);
});
