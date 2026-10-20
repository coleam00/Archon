import '@archon/paths/strip-cwd-env-boot';
import { getPluginsPath, loadArchonEnv } from '@archon/paths/env-loader';
import { provisionImageSlack } from '../packages/cli/src/commands/image-chat-plugin';
import { version } from '../package.json';

export async function provisionDockerPlugins(
  bundleDir = '/opt/archon/image-plugins',
  cwd = '/app'
): Promise<void> {
  loadArchonEnv(cwd);
  if (!process.env.SLACK_BOT_TOKEN) return;
  await provisionImageSlack(bundleDir, {
    pluginsDir: getPluginsPath(),
    projectDir: cwd,
    archonVersion: version,
  });
}

if (import.meta.main) {
  try {
    await provisionDockerPlugins();
  } catch (error) {
    console.error(
      `[archon] Docker Slack provisioning failed: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}
