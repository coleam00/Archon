import { config } from 'dotenv';
import { resolve } from 'node:path';
import { BUNDLED_IS_BINARY } from '@archon/paths/bundled-build';
import { loadArchonEnv } from '@archon/paths/env-loader';

// import.meta.dir is frozen at build time; compiled binaries use Archon env files.
export const envPath = BUNDLED_IS_BINARY
  ? undefined
  : resolve(import.meta.dir, '..', '..', '..', '..', '.env');

if (envPath) {
  const result = config({ path: envPath });
  if (result.error) {
    console.error(`Failed to load .env from ${envPath}: ${result.error.message}`);
    console.error('Hint: Copy .env.example to .env and configure your credentials.');
  }
}

loadArchonEnv(process.cwd());
