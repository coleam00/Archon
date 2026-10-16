import { existsSync } from 'node:fs';
import { join } from 'node:path';

const host = process.argv[process.argv.indexOf('--hostname') + 1];
const authenticated =
  Boolean(
    host === 'github.com' || host?.endsWith('.ghe.com')
      ? process.env.GH_TOKEN || process.env.GITHUB_TOKEN
      : process.env.GH_ENTERPRISE_TOKEN || process.env.GITHUB_ENTERPRISE_TOKEN
  ) || existsSync(join(process.env.GH_CONFIG_DIR ?? '', 'logged-in'));
if (authenticated && process.argv.includes('token')) console.log('fixture-keyring-token');
if (!authenticated) console.error('fixture gh is logged out');
process.exitCode = authenticated ? 0 : 1;
