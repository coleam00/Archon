import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { chatReceiptSchema, type ChatReceipt } from '@archon/plugin-manifest';
import { readReceipts, receiptPath } from '@archon/plugin-manifest/store';
import { IMAGE_SLACK_PLUGIN, provisionImageSlack } from './image-chat-plugin';
import { pluginCommand } from './plugin';
import type { PluginEnvironment } from './plugin-common';

const dockerTest = process.platform === 'win32' ? test.skip : test;
const trackRoot = trackTempRoots();
const descriptor = chatReceiptSchema.shape.descriptor.parse({
  protocol: 'archon-chat/1',
  id: 'slack',
  displayName: 'Slack fixture',
  version: '1',
  capabilities: { defaultWorkflowDispatch: 'background' },
  policy: { workspaceRetention: 'retain' },
});
const secret = 'SENTINEL-SLACK-SECRET';
afterEach(() => {
  mock.restore();
});

async function fixture() {
  const root = trackRoot(await mkdtemp(join(tmpdir(), 'archon-image-plugin-')));
  const bundleDir = join(root, 'bundle');
  const pluginsDir = join(root, 'plugins');
  const marker = join(root, 'executed');
  const script = join(root, 'plugin.js');
  await writeFile(
    script,
    `
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
writeFileSync(${JSON.stringify(marker)}, 'executed');
process.stderr.write(${JSON.stringify(secret)});
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method !== 'initialize') throw new Error('unexpected start');
  console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: ${JSON.stringify(descriptor)} }));
});
setInterval(() => {}, 1000);
`
  );
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const bytes = Buffer.from(`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)}\n`);
  const receipt: ChatReceipt = {
    schemaVersion: 1,
    id: IMAGE_SLACK_PLUGIN,
    tag: 'v1',
    commit: 'a'.repeat(40),
    installedAt: '2026-01-01T00:00:00.000Z',
    manifest: {
      schemaVersion: 1,
      kind: 'chat',
      name: 'slack',
      description: 'Fixture',
      executable: 'archon-chat-slack',
    },
    descriptor: structuredClone(descriptor),
    files: [
      { path: 'archon-chat-slack', sha256: createHash('sha256').update(bytes).digest('hex') },
    ],
  };
  const bundleReceipt = receiptPath(bundleDir, IMAGE_SLACK_PLUGIN);
  await mkdir(dirname(bundleReceipt), { recursive: true });
  await writeFile(bundleReceipt, JSON.stringify(receipt));
  await writeFile(join(bundleDir, 'archon-chat-slack'), bytes);
  const env: PluginEnvironment = { pluginsDir, projectDir: root, archonVersion: '0.12.1' };
  const saveBundle = async () => writeFile(bundleReceipt, JSON.stringify(receipt));
  const install = () => provisionImageSlack(bundleDir, env);
  return { root, bundleDir, pluginsDir, marker, receipt, env, saveBundle, install };
}

dockerTest(
  'local bundle installs offline through initialize and publishes a fresh verified receipt',
  async () => {
    const data = await fixture();
    const fetch = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network'));
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    await data.install();
    const [installed] = await readReceipts(data.pluginsDir);
    expect(installed).toEqual({ ...data.receipt, installedAt: expect.any(String) });
    expect(installed?.installedAt).not.toBe(data.receipt.installedAt);
    expect(await readFile(join(data.pluginsDir, 'archon-chat-slack'))).toEqual(
      await readFile(join(data.bundleDir, 'archon-chat-slack'))
    );
    expect(await Bun.file(data.marker).exists()).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).toContain(
      'Provisioned Slack because Slack token configuration is present'
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  }
);

dockerTest('tampered bundle is refused before any executable runs', async () => {
  const data = await fixture();
  await writeFile(join(data.bundleDir, 'archon-chat-slack'), '#!/bin/sh\ntouch ' + data.marker);
  await expect(data.install()).rejects.toThrow('does not match the image bundle receipt');
  expect(await Bun.file(data.marker).exists()).toBe(false);
  expect(await readReceipts(data.pluginsDir)).toEqual([]);
});

dockerTest('incompatible bundle is refused before inspection', async () => {
  const data = await fixture();
  data.receipt.manifest.compatibility = { archon: '>=99.0.0' };
  await data.saveBundle();
  await expect(data.install()).rejects.toThrow('requires Archon');
  expect(await Bun.file(data.marker).exists()).toBe(false);
});

dockerTest('initialized descriptor must match the bundled receipt', async () => {
  const data = await fixture();
  data.receipt.descriptor = { ...descriptor, version: 'different' };
  await data.saveBundle();
  await expect(data.install()).rejects.toThrow('descriptor does not match image receipt');
  expect(await readReceipts(data.pluginsDir)).toEqual([]);
});

for (const mutation of ['identity', 'executable', 'files', 'descriptor'] as const) {
  dockerTest(`invalid bundle ${mutation} is refused before inspection`, async () => {
    const data = await fixture();
    if (mutation === 'identity') data.receipt.id = '../../outside';
    if (mutation === 'executable') data.receipt.manifest.executable = 'archon-chat-other';
    if (mutation === 'files') data.receipt.files[0]!.path = 'other';
    if (mutation === 'descriptor') data.receipt.descriptor.id = 'other';
    await data.saveBundle();
    await expect(data.install()).rejects.toThrow();
    expect(await Bun.file(data.marker).exists()).toBe(false);
  });
}

dockerTest(
  'existing Slack from another source is retained byte for byte, without reading the bundle',
  async () => {
    const data = await fixture();
    await data.install();
    const original = receiptPath(data.pluginsDir, IMAGE_SLACK_PLUGIN);
    const installed = chatReceiptSchema.parse(JSON.parse(await readFile(original, 'utf8')));
    installed.id = 'operator/slack';
    installed.tag = 'operator-pin';
    const selected = receiptPath(data.pluginsDir, installed.id);
    await mkdir(dirname(selected), { recursive: true });
    await writeFile(selected, JSON.stringify(installed));
    await rm(original);
    await rm(data.bundleDir, { recursive: true });
    await rm(data.marker);
    const before = await readFile(selected);
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    await data.install();
    expect(await readFile(selected)).toEqual(before);
    expect(await Bun.file(data.marker).exists()).toBe(false);
    expect(JSON.stringify(log.mock.calls)).toContain('retained operator/slack@operator-pin');
  }
);

for (const damage of [
  'missing',
  'corrupt',
  'unowned',
  'duplicate-owner',
  'duplicate-platform',
] as const) {
  dockerTest(
    `existing ${damage} Slack install stops provisioning without replacement`,
    async () => {
      const data = await fixture();
      await data.install();
      const selected = receiptPath(data.pluginsDir, IMAGE_SLACK_PLUGIN);
      const before = await readFile(selected);
      const installed = chatReceiptSchema.parse(JSON.parse(before.toString()));
      const executable = join(data.pluginsDir, 'archon-chat-slack');
      if (damage === 'missing') await rm(executable);
      if (damage === 'corrupt') await writeFile(executable, 'corrupted');
      if (damage === 'unowned') {
        installed.files[0]!.path = 'other';
        await writeFile(selected, JSON.stringify(installed));
      }
      if (damage === 'duplicate-owner' || damage === 'duplicate-platform') {
        installed.id = 'operator/other';
        if (damage === 'duplicate-owner') installed.descriptor.id = 'other';
        const duplicate = receiptPath(data.pluginsDir, installed.id);
        await mkdir(dirname(duplicate), { recursive: true });
        await writeFile(duplicate, JSON.stringify(installed));
      }
      const current = await readFile(selected);
      await expect(data.install()).rejects.toThrow();
      expect(await readFile(selected)).toEqual(current);
    }
  );
}

dockerTest('competing file owner and unowned binary refuse fresh provisioning', async () => {
  for (const owned of [false, true]) {
    const data = await fixture();
    await mkdir(data.pluginsDir, { recursive: true });
    const target = join(data.pluginsDir, 'archon-chat-slack');
    await writeFile(target, 'operator binary');
    if (owned) {
      const other = {
        ...data.receipt,
        id: 'operator/other',
        descriptor: { ...descriptor, id: 'other' },
      };
      const path = receiptPath(data.pluginsDir, other.id);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(other));
    }
    await expect(data.install()).rejects.toThrow(
      owned ? 'belongs to operator/other' : 'not installed by archon plugin'
    );
    expect(await Bun.file(target).text()).toBe('operator binary');
    expect(await Bun.file(data.marker).exists()).toBe(false);
  }
});

dockerTest('unrelated broken receipts do not prevent fresh or retained Slack', async () => {
  const data = await fixture();
  const broken = receiptPath(data.pluginsDir, 'operator/broken');
  await mkdir(dirname(broken), { recursive: true });
  await writeFile(broken, '{}');
  await data.install();
  const selected = receiptPath(data.pluginsDir, IMAGE_SLACK_PLUGIN);
  const before = await readFile(selected);
  await data.install();
  expect(await readFile(selected)).toEqual(before);
});

dockerTest('retained Slack does not require the mutation lock', async () => {
  const data = await fixture();
  await data.install();
  const selected = receiptPath(data.pluginsDir, IMAGE_SLACK_PLUGIN);
  const before = await readFile(selected);
  await mkdir(join(data.pluginsDir, '.mutation-lock'));
  await data.install();
  expect(await readFile(selected)).toEqual(before);
});

dockerTest(
  'an unrelated broken receipt cannot authorize replacing an unowned Slack executable',
  async () => {
    const data = await fixture();
    const broken = receiptPath(data.pluginsDir, 'operator/broken');
    await mkdir(dirname(broken), { recursive: true });
    await writeFile(broken, '{}');
    const target = join(data.pluginsDir, 'archon-chat-slack');
    await writeFile(target, 'operator executable');
    await expect(data.install()).rejects.toThrow(
      'may belong to a plugin whose receipt cannot be read'
    );
    expect(await readFile(target, 'utf8')).toBe('operator executable');
    expect(await Bun.file(data.marker).exists()).toBe(false);
  }
);

dockerTest('broken Slack receipt and held lock refuse a required installation', async () => {
  const data = await fixture();
  const broken = receiptPath(data.pluginsDir, IMAGE_SLACK_PLUGIN);
  await mkdir(dirname(broken), { recursive: true });
  await writeFile(broken, '{}');
  await expect(data.install()).rejects.toThrow('Cannot provision Slack');
  await rm(broken);
  await mkdir(join(data.pluginsDir, '.mutation-lock'));
  await expect(data.install()).rejects.toThrow('Plugin mutation locked');
  expect(await Bun.file(data.marker).exists()).toBe(false);
});

dockerTest('removal allows the image plugin to be provisioned again', async () => {
  const data = await fixture();
  await data.install();
  expect(await pluginCommand('remove', [IMAGE_SLACK_PLUGIN], data.env)).toBe(0);
  expect(await readReceipts(data.pluginsDir)).toEqual([]);
  await data.install();
  expect((await readReceipts(data.pluginsDir)).map(entry => entry.id)).toEqual([
    IMAGE_SLACK_PLUGIN,
  ]);
});

dockerTest(
  'failed receipt publication rolls back the local binary and releases the mutation lock',
  async () => {
    const data = await fixture();
    const selected = receiptPath(data.pluginsDir, IMAGE_SLACK_PLUGIN);
    const realRename = fs.rename;
    let refused = false;
    spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      if (target === selected) {
        refused = true;
        throw new Error('injected publication failure');
      }
      return realRename(source, target);
    });
    await expect(data.install()).rejects.toThrow('previous install restored');
    expect(refused).toBe(true);
    expect(await readReceipts(data.pluginsDir)).toEqual([]);
    expect(await Bun.file(join(data.pluginsDir, 'archon-chat-slack')).exists()).toBe(false);
    expect(
      (await readdir(data.pluginsDir)).filter(
        path => path === '.mutation-lock' || path.includes('.partial')
      )
    ).toEqual([]);
  }
);

dockerTest(
  'an installed image id claiming a different platform cannot be overwritten',
  async () => {
    const data = await fixture();
    const selected = receiptPath(data.pluginsDir, IMAGE_SLACK_PLUGIN);
    await mkdir(dirname(selected), { recursive: true });
    await writeFile(
      selected,
      JSON.stringify({ ...data.receipt, descriptor: { ...descriptor, id: 'other' } })
    );
    const before = await readFile(selected);
    await expect(data.install()).rejects.toThrow('different kind or platform');
    expect(await readFile(selected)).toEqual(before);
    expect(await Bun.file(data.marker).exists()).toBe(false);
  }
);
