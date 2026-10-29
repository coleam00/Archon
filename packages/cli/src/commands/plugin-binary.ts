/**
 * Install a `forge`, `provider` or `chat` plugin: its executable comes from the
 * release assets, is checked against the release's checksums.txt and lands in the
 * plugins directory beside its receipt.
 */
import { createHash } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  isMaintainedProviderPlugin,
  maintainedProviderPluginId,
  pluginReleaseAsset,
  isBinaryReceipt,
  isProviderReceipt,
  isChatReceipt,
  pluginReceiptSchema,
  type ProviderManifest,
  type PluginReceipt,
} from '@archon/plugin-manifest';
import {
  receiptPath,
  RECEIPT_FILE,
  isOlderMaintainedProviderReceipt,
  type BrokenReceipt,
} from '@archon/plugin-manifest/store';
import { inspectProviderPlugin } from '@archon/core/providers/inspect-provider-plugin';
import { processProviderRegistration } from '@archon/core/providers/process-registration';
import {
  assertProviderRegistrationAllowed,
  isMaintainedProvider,
  MAINTAINED_PROVIDER_IDS,
  providerVersionMismatchMessage,
} from '@archon/provider-contract';
import { PROVIDER_PLUGIN_PROTOCOL } from '@archon/provider-contract/plugin/wire';
import type { ProviderPluginDescriptor } from '@archon/provider-contract/plugin';
import {
  RESERVED_CHAT_PLATFORMS,
  type ChatPluginDescriptor,
} from '@archon/chat-contract/descriptor';
import { getRegisteredProviders, maintainedDescriptors } from '@archon/providers';
import { registerCopilotProvider } from '@archon/providers/community/copilot';
import { registerOpencodeProvider } from '@archon/providers/community/opencode';
import type { PluginRef, ResolvedBinarySource } from './plugin-source';
import { inspectChatPlugin } from './inspect-chat-plugin';
import { publishPlugin } from './publish-plugin';
import { removeUnlocked } from './unlocked-file';
import {
  assertCompatible,
  brokenReceiptNote,
  pathExists,
  stagingName,
  type PluginEnvironment,
} from './plugin-common';

async function download(url: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const response = await fetch(url);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** Reads the `sha256sum` output that release.yml publishes as checksums.txt. */
function expectedDigest(checksums: string, asset: string): string | undefined {
  for (const line of checksums.split('\n')) {
    const match = /^([0-9a-f]{64}) [ *](.+?)\r?$/.exec(line);
    if (match?.[2] === asset) return match[1];
  }
  return undefined;
}

async function inspectInstallableProvider(
  stagedBinary: string,
  manifest: ProviderManifest,
  receipts: readonly PluginReceipt[],
  id: string,
  version: string
): Promise<ProviderPluginDescriptor> {
  const descriptor = await inspectProviderPlugin(stagedBinary);
  if (manifest.executable !== `archon-provider-${descriptor.id}`) {
    throw new Error(`Provider plugin ${id}: descriptor id must match ${manifest.executable}`);
  }
  const providerId = descriptor.id;
  const maintained = isMaintainedProvider(providerId);
  if (maintained && !isMaintainedProviderPlugin(id, providerId)) {
    throw new Error(
      `Provider '${descriptor.id}' installs only from ${maintainedProviderPluginId(providerId)}. Nothing was installed.`
    );
  }
  if (maintained && descriptor.version !== version) {
    throw new Error(providerVersionMismatchMessage(descriptor.id, descriptor.version, version));
  }
  const registration = processProviderRegistration(descriptor, [stagedBinary]);
  registerOpencodeProvider();
  registerCopilotProvider();
  // Maintained ids stay reserved whether this host runs them from source or from receipts.
  const reserved = MAINTAINED_PROVIDER_IDS.filter(entry => entry !== descriptor.id).map(entry =>
    processProviderRegistration(maintainedDescriptors[entry], [stagedBinary])
  );
  const installed = receipts.filter(isProviderReceipt).filter(receipt => receipt.id !== id);
  const registrations = [
    ...getRegisteredProviders().filter(provider => !isMaintainedProvider(provider.id)),
    ...reserved,
    ...installed.map(receipt => processProviderRegistration(receipt.descriptor, [stagedBinary])),
  ];
  assertProviderRegistrationAllowed(registration, registrations);
  return descriptor;
}

async function inspectInstallableChat(
  stagedBinary: string,
  receipts: readonly PluginReceipt[],
  id: string
): Promise<ChatPluginDescriptor> {
  const descriptor = await inspectChatPlugin(stagedBinary);
  const owner =
    RESERVED_CHAT_PLATFORMS.get(descriptor.id) ??
    receipts.find(
      receipt =>
        isChatReceipt(receipt) && receipt.id !== id && receipt.descriptor.id === descriptor.id
    )?.id;
  if (owner) throw new Error(`Chat platform ${descriptor.id}: ${id} collides with ${owner}`);
  return descriptor;
}

interface BinaryPluginArtifact {
  bytes: Uint8Array;
  sha256: string;
  label: string;
  digestSource: string;
}

export async function downloadBinary(
  ref: PluginRef,
  source: ResolvedBinarySource,
  env: PluginEnvironment
): Promise<BinaryPluginArtifact> {
  const { tag, manifest } = source;
  const githubUrl = env.githubUrl ?? 'https://github.com';
  const platform = env.platform ?? process.platform;
  const bunTarget = `bun-${platform === 'win32' ? 'windows' : platform}-${env.arch ?? process.arch}`;
  const asset = pluginReleaseAsset(manifest.executable, bunTarget);
  const releaseUrl = `${githubUrl}/${ref.owner}/${ref.repo}/releases/download/${encodeURIComponent(tag)}`;
  const bytes = await download(`${releaseUrl}/${asset}`);
  if (!bytes) {
    throw new Error(`Release ${tag} of ${ref.owner}/${ref.repo} has no ${asset} for this platform`);
  }
  const checksums = await download(`${releaseUrl}/checksums.txt`);
  if (!checksums)
    throw new Error(`Release ${tag} of ${ref.owner}/${ref.repo} has no checksums.txt`);
  const expected = expectedDigest(new TextDecoder().decode(checksums), asset);
  if (!expected) throw new Error(`checksums.txt of release ${tag} has no entry for ${asset}`);
  return {
    bytes,
    sha256: expected,
    label: asset,
    digestSource: `checksums.txt of release ${tag}`,
  };
}

export function canUpgradeProvider(
  id: string,
  fileName: string,
  broken: readonly BrokenReceipt[]
): boolean {
  const self = broken.find(entry => entry.id === id)?.incompatibleProviderReceipt;
  if (!isOlderMaintainedProviderReceipt(self, fileName)) return false;
  return broken.every(entry => {
    if (entry.id === id) return true;
    const peer = entry.incompatibleProviderReceipt;
    return (
      peer !== undefined &&
      peer.descriptor.protocol < PROVIDER_PLUGIN_PROTOCOL &&
      !peer.files.some(file => file.path.toLowerCase() === fileName.toLowerCase())
    );
  });
}

/** Refuse a target another plugin owns, or one that may belong to a plugin whose receipt is broken. */
async function assertTargetClaimable(
  ref: PluginRef,
  fileName: string,
  target: string,
  receipts: readonly PluginReceipt[],
  broken: readonly BrokenReceipt[]
): Promise<void> {
  const owner = receipts.find(
    receipt => isBinaryReceipt(receipt) && receipt.files.some(f => f.path === fileName)
  );
  if (owner && owner.id !== ref.id) {
    throw new Error(
      `${target} belongs to ${owner.id}. Remove it first: archon plugin remove ${owner.id}`
    );
  }
  if (owner || !(await pathExists(target))) return;
  if (canUpgradeProvider(ref.id, fileName, broken)) return;
  // Preserve sole broken-self repair when no other receipt could own the target.
  // The target is inside pluginsDir: executable names cannot contain separators.
  const others = broken.filter(entry => entry.id !== ref.id);
  if (others.length > 0) {
    throw new Error(
      `${target} exists and may belong to a plugin whose receipt cannot be read, so nothing was installed. Delete ${target} by hand if no plugin owns it, or repair first:\n${others.map(brokenReceiptNote).join('\n')}`
    );
  }
  if (!broken.some(entry => entry.id === ref.id)) {
    throw new Error(
      `${target} exists but was not installed by archon plugin. Move or delete it, then retry.`
    );
  }
}

/** The artifact's sha256, once it matches the digest its source published. */
function verifiedDigest({ bytes, sha256, label, digestSource }: BinaryPluginArtifact): string {
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== sha256) {
    throw new Error(
      `${label} does not match ${digestSource} (expected ${sha256}, got ${digest}). Nothing was installed.`
    );
  }
  return digest;
}

/** The descriptor a staged provider or chat executable reports, checked against what is installed. */
async function inspectStagedBinary(
  stagedBinary: string,
  manifest: ResolvedBinarySource['manifest'],
  receipts: readonly PluginReceipt[],
  id: string,
  archonVersion: string
): Promise<ProviderPluginDescriptor | ChatPluginDescriptor | undefined> {
  if (manifest.kind === 'provider') {
    return inspectInstallableProvider(stagedBinary, manifest, receipts, id, archonVersion);
  }
  if (manifest.kind === 'chat') return inspectInstallableChat(stagedBinary, receipts, id);
  return undefined;
}

/** Remove what a failed install staged without replacing the reason it failed. */
async function removeStaged(paths: readonly string[]): Promise<void> {
  for (const staged of paths) {
    try {
      await removeUnlocked(staged);
    } catch (cleanup) {
      console.warn(`Could not remove ${staged}: ${(cleanup as Error).message}`);
    }
  }
}

export async function installBinaryPlugin(
  ref: PluginRef,
  source: ResolvedBinarySource,
  receipts: PluginReceipt[],
  broken: readonly BrokenReceipt[],
  previous: PluginReceipt | undefined,
  env: PluginEnvironment,
  acquire: () => Promise<BinaryPluginArtifact>,
  expectedChatDescriptor?: ChatPluginDescriptor
): Promise<void> {
  const { tag, commit, manifest } = source;
  assertCompatible(`${ref.id}@${tag}`, manifest, env.archonVersion);
  const platform = env.platform ?? process.platform;
  const fileName = `${manifest.executable}${platform === 'win32' ? '.exe' : ''}`;
  const target = join(env.pluginsDir, fileName);
  await assertTargetClaimable(ref, fileName, target, receipts, broken);

  const artifact = await acquire();
  const digest = verifiedDigest(artifact);

  const receiptFile = receiptPath(env.pluginsDir, ref.id);
  const stagedBinary = join(env.pluginsDir, stagingName(fileName));
  const stagedReceipt = join(dirname(receiptFile), stagingName(RECEIPT_FILE));
  await mkdir(dirname(receiptFile), { recursive: true });
  try {
    await writeFile(stagedBinary, artifact.bytes);
    await chmod(stagedBinary, 0o755);
    const descriptor = await inspectStagedBinary(
      stagedBinary,
      manifest,
      receipts,
      ref.id,
      env.archonVersion
    );
    if (expectedChatDescriptor && !isDeepStrictEqual(descriptor, expectedChatDescriptor)) {
      throw new Error(`Chat plugin ${ref.id}: initialized descriptor does not match image receipt`);
    }
    const receipt = pluginReceiptSchema.parse({
      schemaVersion: 1,
      id: ref.id,
      manifest,
      tag,
      commit,
      installedAt: new Date().toISOString(),
      files: [{ path: fileName, sha256: digest }],
      ...(descriptor ? { descriptor } : {}),
    });
    await writeFile(stagedReceipt, `${JSON.stringify(receipt, null, 2)}\n`);
    await publishPlugin({
      stagedReceipt,
      receiptFile,
      stagedBinary,
      target,
      previousFiles:
        previous && isBinaryReceipt(previous)
          ? previous.files.map(file => join(env.pluginsDir, file.path))
          : [],
    });
  } catch (error) {
    // Cleanup runs only on failure: success renamed both staged files away.
    await removeStaged([stagedBinary, stagedReceipt]);
    throw error;
  }

  const from = `github.com/${ref.owner}/${ref.repo} ${tag} (commit ${commit})`;
  console.log(
    previous
      ? `Updated ${ref.id}: ${previous.tag} (commit ${previous.commit}) -> ${from}`
      : `Installed ${ref.id} from ${from}`
  );
  console.log(`  ${target}  sha256 ${digest}`);
  console.log(`  This runs code published by ${ref.owner}.`);
}
