/** `archon plugin remove | copy | list`: operations on plugins already installed. */
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isBinaryReceipt } from '@archon/plugin-manifest';
import { packTreePath, receiptPath, scanReceipts } from '@archon/plugin-manifest/store';
import type { PluginRef } from './plugin-source';
import { brokenReceiptNote, pathExists, type PluginEnvironment } from './plugin-common';

export async function removePlugin(ref: PluginRef, env: PluginEnvironment): Promise<void> {
  const { receipts, broken } = await scanReceipts(env.pluginsDir);
  const brokenSelf = broken.find(entry => entry.id === ref.id);
  if (brokenSelf) {
    await rm(brokenSelf.file);
    console.log(
      `Removed the ${brokenSelf.unavailableReason ? 'unavailable' : 'unreadable'} receipt of ${ref.id}: ${brokenSelf.file}. File ownership could not be verified, so the files were left in place; look for its executable in ${env.pluginsDir} or its workflow pack under ${join(env.pluginsDir, 'packs', ...ref.id.split('/'))}.`
    );
    return;
  }
  const receipt = receipts.find(candidate => candidate.id === ref.id);
  if (!receipt) throw new Error(`${ref.id} is not installed`);
  let removed: string;
  if (isBinaryReceipt(receipt)) {
    for (const file of receipt.files) await rm(join(env.pluginsDir, file.path), { force: true });
    removed = receipt.files.map(file => file.path).join(', ');
  } else {
    removed = packTreePath(env.pluginsDir, receipt.id, receipt.commit);
    await rm(removed, { recursive: true, force: true });
  }
  await rm(receiptPath(env.pluginsDir, ref.id));
  console.log(`Removed ${ref.id}: ${removed}`);
}

/** Makes an ordinary project copy of an installed pack; the copy is the project's from then on. */
export async function copyPlugin(ref: PluginRef, env: PluginEnvironment): Promise<void> {
  const { receipts, broken } = await scanReceipts(env.pluginsDir);
  const brokenSelf = broken.find(entry => entry.id === ref.id);
  if (brokenSelf) throw new Error(brokenReceiptNote(brokenSelf));
  const receipt = receipts.find(candidate => candidate.id === ref.id);
  if (!receipt) throw new Error(`${ref.id} is not installed`);
  if (receipt.manifest.kind !== 'workflow-pack') {
    throw new Error(`${ref.id} is a ${receipt.manifest.kind} plugin; only workflow packs copy`);
  }
  const { resolveDiscoveryCwd } = await import('../utils/project-cwd');
  const project = await resolveDiscoveryCwd(env.projectDir);
  const target = join(project, '.archon', 'workflows', receipt.manifest.name);
  if (await pathExists(target)) {
    throw new Error(`${target} already exists. Move or delete it, then retry.`);
  }
  await mkdir(dirname(target), { recursive: true });
  await cp(packTreePath(env.pluginsDir, receipt.id, receipt.commit), target, { recursive: true });
  console.log(`Copied ${ref.id} (commit ${receipt.commit}) to ${target}`);
  console.log(
    '  Its workflows are now project workflows under their own names. `archon plugin update` does not change this copy.'
  );
}

export async function listPlugins(env: PluginEnvironment): Promise<void> {
  const { receipts, broken } = await scanReceipts(env.pluginsDir);
  if (receipts.length === 0 && broken.length === 0) {
    console.log('No plugins installed.');
    return;
  }
  for (const receipt of receipts) {
    const archon = receipt.manifest.compatibility?.archon ?? 'any';
    console.log(
      `${receipt.id}  ${receipt.manifest.kind}  ${receipt.tag ?? '-'}  ${receipt.commit.slice(0, 12)}  archon ${archon}`
    );
  }
  for (const entry of broken) {
    console.log(
      `${entry.id}  ${entry.unavailableReason ? 'unavailable' : 'unreadable'}  ${brokenReceiptNote(entry)}`
    );
  }
}
