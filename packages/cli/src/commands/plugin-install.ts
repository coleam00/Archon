import { isBinaryReceipt, type PluginReceipt } from '@archon/plugin-manifest';
import { scanReceipts, type BrokenReceipt } from '@archon/plugin-manifest/store';
import { parsePluginRef, resolveSource, type PluginRef } from './plugin-source';
import { brokenReceiptNote, type PluginEnvironment } from './plugin-common';
import { downloadBinary, installBinaryPlugin } from './plugin-binary';
import { installPack } from './plugin-pack';
import { withPluginMutationLock } from './plugin-mutation-lock';

type InstallMode = 'install' | 'update' | 'replace';

/** Refuse an install that the receipts already on disk rule out for `mode`. */
function assertInstallAllowed(
  ref: PluginRef,
  mode: InstallMode,
  previous: PluginReceipt | undefined,
  brokenSelf: BrokenReceipt | undefined,
  broken: readonly BrokenReceipt[]
): void {
  if (mode === 'install' && previous) {
    throw new Error(
      `${ref.id} is already installed at ${previous.tag ?? 'the default branch head'} (${previous.commit}). Use: archon plugin update ${ref.id}`
    );
  }
  if (mode === 'install' && brokenSelf) {
    throw new Error(
      `${ref.id} is installed, but its receipt is broken: ${brokenReceiptNote(brokenSelf)}`
    );
  }
  if (previous || brokenSelf) return;
  if (mode === 'update') {
    throw new Error(`${ref.id} is not installed. Use: archon plugin add ${ref.id}`);
  }
  // A fresh install cannot know which files a broken receipt owns, so it could claim them.
  if (broken.length > 0) {
    throw new Error(
      `Nothing was installed: the files these plugins own are unknown until their receipts are repaired.\n${broken.map(brokenReceiptNote).join('\n')}`
    );
  }
}

export async function installPlugin(
  ref: PluginRef,
  mode: InstallMode,
  env: PluginEnvironment,
  expectedCommit?: string
): Promise<void> {
  const { receipts, broken } = await scanReceipts(env.pluginsDir);
  const previous = receipts.find(receipt => receipt.id === ref.id);
  const brokenSelf = broken.find(entry => entry.id === ref.id);
  assertInstallAllowed(ref, mode, previous, brokenSelf, broken);

  const source = await resolveSource(ref, previous?.manifest.kind, env, expectedCommit);
  if (previous && previous.manifest.kind !== source.kind) {
    throw new Error(
      `${ref.id} is now a ${source.kind} plugin, not ${previous.manifest.kind}. Remove it, then install it again.`
    );
  }
  if (source.kind !== 'workflow-pack') {
    await installBinaryPlugin(ref, source, receipts, broken, previous, env, () =>
      downloadBinary(ref, source, env)
    );
  } else {
    // The kind check above means an existing receipt here is a pack receipt.
    const packReceipt = previous && !isBinaryReceipt(previous) ? previous : undefined;
    await installPack(ref, source, receipts, packReceipt, env);
  }
  if (brokenSelf) {
    console.log(
      `  Replaced the unreadable receipt ${brokenSelf.file}. The files it named could not be identified; any this install did not overwrite remain under ${env.pluginsDir}.`
    );
  }
}

export async function installPinnedPlugin(
  ref: string,
  expectedCommit: string,
  env: PluginEnvironment
): Promise<void> {
  const parsed = parsePluginRef(ref);
  if (!parsed.tag) throw new Error('Image plugins require an explicit release tag');
  await withPluginMutationLock(env.pluginsDir, () =>
    installPlugin(parsed, 'install', env, expectedCommit)
  );
}

export async function replacePlugin(ref: string, env: PluginEnvironment): Promise<void> {
  await withPluginMutationLock(env.pluginsDir, () =>
    installPlugin(parsePluginRef(ref), 'replace', env)
  );
}
