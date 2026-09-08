import { repoRefSchema } from '@archon/forge';

// Scratch file remotes have no forge identity. Supply only that resolution;
// public operations still run through the real CLI, dispatcher and GitHub plugin.
const [repoJson] = process.argv.splice(3, 1);
const repo = repoRefSchema.parse(JSON.parse(repoJson ?? 'null'));
if (process.argv.slice(3).join(' ') === 'forge resolve --json') {
  process.stdout.write(JSON.stringify({ forge: 'github', repo }));
} else {
  await import('./forge-public-cli');
}
