import { createHash } from 'crypto';
import { mkdir, stat, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import * as archonPaths from '@archon/paths';
import { BUNDLED_VERSION } from '@archon/paths/bundled-build';
import {
  BUNDLED_COMMANDS,
  BUNDLED_SCRIPT_PACKS,
  BUNDLED_WORKFLOWS,
  BUNDLED_WORKFLOW_PATHS,
  isBinaryBuild,
} from '../defaults/bundled-defaults';
import {
  collectInstalledBundleSources,
  readBundleContent,
  type BundleSourceFile,
} from '../defaults/bundle-inventory';
import { parsePackagedResourceReference } from '../packaged-workflow';
import type { DigestEntry } from './manifest';
import { BUNDLED_SCOPE_DIR } from './roots';
import type { TreeFile, TreeListing } from './tree';

/**
 * One bundled file, held ready to be written into a capture.
 *
 * It IS its own digest entry: `relPath` is already capture-relative, under the `bundled`
 * scope directory, so the scope can be folded into a capture's digest without a second
 * pass over what was just written.
 */
interface BundledFile extends DigestEntry {
  readonly content: string | Buffer;
}

/**
 * Selected bundled bytes held in this process and written into every run's own capture.
 * Independent files let paused runs verify their source after an Archon upgrade; sharing
 * a mutable file with another capture or the authoring tree would violate that contract.
 *
 * Source builds reselect the indexed inventory and compare size/mtime on every capture,
 * so additions, edits and deletions remain visible without rereading unchanged bytes.
 * A binary's embedded constants cannot change and are read once.
 */
export interface BundledScope {
  /** Identity of the build these bytes came from. */
  readonly key: string;
  /** Fingerprint of the live trees they were read from; empty for a binary's constants. */
  readonly stamp: string;
  /** Capture-relative directories, including ones with no files of their own. */
  readonly dirs: readonly string[];
  readonly files: readonly BundledFile[];
  readonly byteCount: number;
}

/** Accumulator shared by both branches that build a {@link BundledScope}. */
function bundledScopeBuilder(): {
  add: (relPath: string, content: string | Buffer) => void;
  addDir: (relPath: string) => void;
  result: () => Omit<BundledScope, 'key' | 'stamp'>;
} {
  const dirs: string[] = [];
  const files: BundledFile[] = [];
  let byteCount = 0;

  const seen = new Set<string>();
  const addDir = (relPath: string): void => {
    const scoped = join(BUNDLED_SCOPE_DIR, relPath);
    if (seen.has(scoped)) return;
    seen.add(scoped);
    dirs.push(scoped);
  };

  return {
    addDir,
    add: (relPath, content): void => {
      addDir(dirname(relPath));
      files.push({
        relPath: join(BUNDLED_SCOPE_DIR, relPath),
        content,
        hash: createHash('sha256').update(content).digest('hex'),
      });
      byteCount += Buffer.byteLength(content);
    },
    result: () => ({ dirs, files, byteCount }),
  };
}

/**
 * Read a binary's embedded bundled defaults, in the same layout a source build keeps them
 * in on disk.
 *
 * Mirroring the on-disk shape is the whole trick: every resolver already knows how to read
 * bundled workflows, commands, and scripts from a directory, so once the constants are
 * files under the capture's roots, the ordinary filesystem path serves a binary too and no
 * resolver needs a second way to find them.
 */
function readBundledConstants(): Omit<BundledScope, 'key' | 'stamp'> {
  const { add: write, result } = bundledScopeBuilder();

  for (const [name, content] of Object.entries(BUNDLED_WORKFLOWS)) {
    // The generator owns authored extensions and legacy subfolders, too.
    const path = BUNDLED_WORKFLOW_PATHS[name];
    if (path === undefined) throw new Error(`Bundled workflow "${name}" has no source path.`);
    write(path, content);
  }

  for (const [name, content] of Object.entries(BUNDLED_COMMANDS)) {
    const packaged = parsePackagedResourceReference(name);
    const relative = packaged
      ? join(
          'workflows',
          packaged.owner.pack,
          packaged.owner.workflow,
          'commands',
          `${packaged.name}.md`
        )
      : join('commands', 'defaults', `${name}.md`);
    write(relative, content);
  }

  for (const [pack, bundled] of Object.entries(BUNDLED_SCRIPT_PACKS)) {
    for (const [relativePath, content] of Object.entries(bundled.files)) {
      write(join('workflows', pack, relativePath), content);
    }
  }

  return result();
}

/** Read only the generator's selected source files, using the same LF normalization. */
async function readBundledSources(
  files: readonly BundleSourceFile[]
): Promise<Omit<BundledScope, 'key' | 'stamp'>> {
  const { add, addDir, result } = bundledScopeBuilder();
  addDir('workflows');
  addDir(join('commands', 'defaults'));
  for (const file of files) add(file.relativePath, await readBundleContent(file));
  return result();
}

let bundledScope: BundledScope | undefined;

/**
 * Identity of the live bundled trees: their shape plus every file's size and mtime.
 *
 * Size and mtime is the freshness signal incremental build tools run on. It cannot see an
 * edit that preserves both, which re-reading every byte would — but re-reading every byte
 * is the cost being removed here, and every capture is still digest-verified against the
 * bytes it actually contains before anything executes from it.
 */
function stampListings(listings: readonly { name: string; listing: TreeListing }[]): string {
  const hash = createHash('sha256');
  for (const { name, listing } of listings) {
    hash.update(`scope\0${name}\n`);
    for (const dir of listing.dirs) hash.update(`d\0${dir}\n`);
    for (const file of listing.files) {
      hash.update(`f\0${file.relPath}\0${String(file.size)}\0${String(file.mtimeMs)}\n`);
    }
  }
  return hash.digest('hex');
}

/** This build's bundled bytes, read or revalidated as the build requires. */
export async function resolveBundledScope(): Promise<BundledScope | undefined> {
  if (isBinaryBuild()) {
    const key = `binary\0${BUNDLED_VERSION}`;
    if (bundledScope?.key !== key) {
      const read = readBundledConstants();
      // A binary with no embedded bundled set has no bundled scope to capture, exactly as
      // a source build with no bundled directories on disk has none.
      if (read.files.length === 0) return undefined;
      bundledScope = { key, stamp: '', ...read };
    }
    return bundledScope;
  }

  // Every bundled pack, with its commands and scripts, lives under the workflows root.
  const workflowsRoot = archonPaths.getBundledWorkflowsPath();
  const sources = await collectInstalledBundleSources(workflowsRoot);
  if (!sources) return undefined;
  const files: TreeFile[] = [];
  for (const file of sources) {
    const info = await stat(file.sourcePath);
    files.push({
      relPath: file.relativePath,
      absPath: file.sourcePath,
      size: info.size,
      mtimeMs: info.mtimeMs,
    });
  }

  const key = `source\0${workflowsRoot}`;
  const stamp = stampListings([{ name: 'bundled', listing: { dirs: [], files } }]);
  if (bundledScope?.key !== key || bundledScope.stamp !== stamp) {
    bundledScope = { key, stamp, ...(await readBundledSources(sources)) };
  }
  return bundledScope;
}

/** Write this build's bundled bytes into a staged capture. */
export async function writeBundledScope(scope: BundledScope, staging: string): Promise<void> {
  for (const dir of scope.dirs) await mkdir(join(staging, dir), { recursive: true });
  for (const file of scope.files) await writeFile(join(staging, file.relPath), file.content);
}
