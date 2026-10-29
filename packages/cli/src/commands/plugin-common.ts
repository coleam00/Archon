import { randomBytes } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import type { PluginManifest } from '@archon/plugin-manifest';
import type { BrokenReceipt } from '@archon/plugin-manifest/store';
import { parsePluginRef, type PluginRef } from './plugin-source';

export interface PluginEnvironment {
  /** `ARCHON_HOME/plugins`, the directory forge discovery scans. */
  pluginsDir: string;
  archonVersion: string;
  /** Where `copy` starts looking for its project: the working directory, or `--cwd`. */
  projectDir: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Replaced only by tests, which serve a GitHub fixture from local HTTP and a file URL. */
  githubUrl?: string;
  rawUrl?: string;
}

/**
 * A name forge discovery never treats as a plugin: it does not start with
 * `archon-forge-`, so a half-written binary is never executed by a concurrent scan.
 */
export function stagingName(fileName: string): string {
  return `.${fileName}.${randomBytes(6).toString('hex')}.partial${fileName.endsWith('.exe') ? '.exe' : ''}`;
}

export function brokenReceiptNote(broken: BrokenReceipt): string {
  // A receipt.json placed outside the owner/repo layout has no id the commands accept.
  let ref: PluginRef;
  try {
    ref = parsePluginRef(broken.id);
  } catch {
    return `${broken.message}. It is not where archon plugin writes receipts; delete it by hand (${broken.file})`;
  }
  if (ref.id !== broken.id) {
    return `${broken.message}. It is not where archon plugin writes receipts; delete it by hand (${broken.file})`;
  }
  if (broken.unavailableReason) return broken.message;
  return `${broken.message}. Repair it: archon plugin update ${broken.id}, or archon plugin remove ${broken.id}`;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function assertCompatible(
  label: string,
  manifest: PluginManifest,
  archonVersion: string
): void {
  const range = manifest.compatibility?.archon;
  if (range && !Bun.semver.satisfies(archonVersion, range)) {
    throw new Error(`${label} requires Archon ${range}; this is Archon ${archonVersion}`);
  }
}
