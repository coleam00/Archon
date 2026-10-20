import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { readReceipts, receiptPath } from '../packages/plugin-manifest/src/store';
import { IMAGE_SLACK_PLUGIN } from '../packages/cli/src/commands/image-chat-plugin';
import { pluginCommand } from '../packages/cli/src/commands/plugin';
import { provisionDockerPlugins } from './provision-docker-plugins';
import { createSlackFixtureBundle } from './fixtures/prepare-docker-slack-fixture';

const trackRoot = trackTempRoots();
const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
  mock.restore();
});

async function fixture() {
  const root = trackRoot(await mkdtemp(join(tmpdir(), 'docker-provision-')));
  const home = join(root, 'home');
  const cwd = join(root, 'app');
  const bundle = join(root, 'bundle');
  await mkdir(home);
  await mkdir(join(cwd, '.archon'), { recursive: true });
  process.env.ARCHON_HOME = home;
  process.env.ARCHON_DOCKER = '';
  process.env.WORKSPACE_PATH = '';
  process.env.SLACK_BOT_TOKEN = '';
  process.env.SLACK_APP_TOKEN = '';
  const env = { pluginsDir: join(home, 'plugins'), projectDir: cwd, archonVersion: '0.12.1' };
  const provision = () => provisionDockerPlugins(bundle, cwd);
  return { home, cwd, bundle, env, provision };
}

test.skipIf(process.platform === 'win32')(
  'no declaration creates nothing; bot token alone provisions offline without logging it',
  async () => {
    const data = await fixture();
    await data.provision();
    expect(await Bun.file(join(data.env.pluginsDir, 'archon-chat-slack')).exists()).toBe(false);
    await createSlackFixtureBundle(data.bundle);
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    const network = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network permitted'));
    process.env.SLACK_BOT_TOKEN = 'SENTINEL-BOT-TOKEN';
    await data.provision();
    expect((await readReceipts(data.env.pluginsDir)).map(entry => entry.id)).toEqual([
      IMAGE_SLACK_PLUGIN,
    ]);
    expect(JSON.stringify(log.mock.calls)).toContain(
      'Provisioned Slack because Slack token configuration is present'
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain('SENTINEL-BOT-TOKEN');
    expect(network).not.toHaveBeenCalled();
  }
);

test.skipIf(process.platform === 'win32')(
  'Archon env files override container env in the same order as server boot',
  async () => {
    const data = await fixture();
    await createSlackFixtureBundle(data.bundle);
    process.env.SLACK_BOT_TOKEN = 'container';
    await writeFile(join(data.home, '.env'), 'SLACK_BOT_TOKEN=user\n');
    await writeFile(join(data.cwd, '.archon', '.env'), 'SLACK_BOT_TOKEN=\n');
    await data.provision();
    expect(await readReceipts(data.env.pluginsDir)).toEqual([]);
    await writeFile(join(data.cwd, '.archon', '.env'), 'SLACK_BOT_TOKEN=repo\n');
    await data.provision();
    expect(process.env.SLACK_BOT_TOKEN).toBe('repo');
    const receipt = receiptPath(data.env.pluginsDir, IMAGE_SLACK_PLUGIN);
    const before = await readFile(receipt);
    await data.provision();
    expect(await readFile(receipt)).toEqual(before);
  }
);

test.skipIf(process.platform === 'win32')(
  'tokens recreate a removed installation; clearing effective tokens keeps it removed',
  async () => {
    const data = await fixture();
    await createSlackFixtureBundle(data.bundle);
    await writeFile(join(data.home, '.env'), 'SLACK_BOT_TOKEN=user\n');
    await data.provision();
    expect(await pluginCommand('remove', [IMAGE_SLACK_PLUGIN], data.env)).toBe(0);
    await data.provision();
    expect((await readReceipts(data.env.pluginsDir)).length).toBe(1);
    expect(await pluginCommand('remove', [IMAGE_SLACK_PLUGIN], data.env)).toBe(0);
    await writeFile(join(data.home, '.env'), 'SLACK_BOT_TOKEN=\n');
    await data.provision();
    expect(await readReceipts(data.env.pluginsDir)).toEqual([]);
  }
);
