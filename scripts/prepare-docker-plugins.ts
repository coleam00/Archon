import { installPinnedPlugin } from '../packages/cli/src/commands/plugin-install';
import { IMAGE_SLACK_PLUGIN } from '../packages/cli/src/commands/image-chat-plugin';
import { version } from '../package.json';

const tag = process.env.SLACK_PLUGIN_TAG;
const commit = process.env.SLACK_PLUGIN_COMMIT;
if (!tag || !commit) throw new Error('SLACK_PLUGIN_TAG and SLACK_PLUGIN_COMMIT are required');
await installPinnedPlugin(`${IMAGE_SLACK_PLUGIN}@${tag}`, commit, {
  pluginsDir: '/opt/archon/image-plugins',
  projectDir: '/app',
  archonVersion: version,
});
