import { existsSync } from 'node:fs';
import { join } from 'node:path';

const authenticated =
  Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN) ||
  existsSync(join(process.env.GH_CONFIG_DIR ?? '', 'logged-in'));
if (authenticated && process.argv.includes('token')) console.log('fixture-keyring-token');
if (!authenticated) console.error('fixture gh is logged out');
process.exitCode = authenticated ? 0 : 1;
