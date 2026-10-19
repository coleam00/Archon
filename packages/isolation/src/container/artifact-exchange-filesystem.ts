import { RUN_ARTIFACTS_ENGINE_SUBDIR } from '@archon/paths';
import { NODES_SUBDIR } from '@archon/workflows/artifact-exchange';
import { MANAGED_PROVIDER_CREDENTIAL_RELATIVE_PATHS } from '@archon/workflows/deps';

export type TransferDirection = 'publish' | 'collect';

interface TransferOptions {
  direction: TransferDirection;
  canonical: string;
  output: string;
  logicalRoot: string;
  directories: readonly string[];
  credentials: readonly string[];
}

/** Self-contained: serialized into trusted helper code, with no imports from either mount. */
async function transferArtifacts(options: TransferOptions): Promise<void> {
  const fs = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  const path = await import('node:path');
  const { default: crypto } = await import('node:crypto');
  const { canonical, output, direction, directories, credentials, logicalRoot } = options;
  const publishing = direction === 'publish';
  const reserved = (rel: string): boolean =>
    directories.some(dir => rel === dir || rel.startsWith(`${dir}/`)) || credentials.includes(rel);
  const protectsDescendant = (rel: string): boolean =>
    [...directories, ...credentials].some(entry => entry.startsWith(`${rel}/`));
  const inside = (root: string, file: string): boolean => {
    const rel = path.relative(root, file);
    return rel !== '' && !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`);
  };
  const refuse = (rel: string, reason: string): never => {
    throw new Error(`Artifact exchange refused ${JSON.stringify(rel)}: ${reason}`);
  };
  const maybeStat = async (file: string) => {
    try {
      return await fs.lstat(file);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
  };
  for (const root of [canonical, output]) {
    const info = await fs.lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) refuse(root, 'root must be a real directory');
  }
  const owner = await fs.lstat(canonical);
  const own = async (file: string, mode: number): Promise<void> => {
    await fs.chmod(file, mode);
    if (!publishing && process.platform !== 'win32') {
      try {
        await fs.chown(file, owner.uid, owner.gid);
      } catch (cause) {
        throw new Error(`Cannot restore artifact ownership ${owner.uid}:${owner.gid}`, { cause });
      }
    }
  };
  const checkParents = async (root: string, rel: string): Promise<void> => {
    if (!inside(root, path.resolve(root, rel))) refuse(rel, 'path escapes root');
    let current = root;
    for (const part of path.dirname(rel).split('/')) {
      if (part === '.') continue;
      current = path.join(current, part);
      const info = await maybeStat(current);
      if (!info) return;
      if (!info.isDirectory() || info.isSymbolicLink())
        refuse(rel, 'parent must be a real directory');
    }
  };
  const mkdir = async (root: string, rel: string): Promise<void> => {
    if (rel === '.') return;
    await checkParents(root, `${rel}/_`);
    let current = root;
    for (const part of rel.split('/')) {
      current = path.join(current, part);
      if (!(await maybeStat(current))) {
        await fs.mkdir(current);
        await own(current, 0o755);
      }
    }
  };
  const canonicalFiles = new Set<string>();
  const canonicalDirs = new Set<string>();
  const walkCanonicalInputs = async (rel: string): Promise<void> => {
    await checkParents(canonical, rel);
    const file = path.join(canonical, rel);
    const info = await maybeStat(file);
    if (!info) return;
    if (info.isSymbolicLink()) refuse(rel, 'engine input is a symlink');
    if (info.isDirectory()) {
      canonicalDirs.add(rel);
      for (const child of await fs.readdir(file)) await walkCanonicalInputs(`${rel}/${child}`);
    } else if (info.isFile()) {
      canonicalFiles.add(rel);
    } else refuse(rel, 'engine input is not a regular file');
  };
  for (const dir of directories) await walkCanonicalInputs(dir);
  for (const credential of credentials) {
    await checkParents(canonical, credential);
    const info = await maybeStat(path.join(canonical, credential));
    if (info && !info.isFile()) refuse(credential, 'credential must be a regular file');
    if (info) canonicalFiles.add(credential);
  }

  // Reserved entries are never imported, but a linked parent there must still fail visibly.
  const validateReserved = async (rel: string): Promise<void> => {
    await checkParents(output, rel);
    const file = path.join(output, rel);
    const info = await maybeStat(file);
    if (!info) return;
    if (info.isSymbolicLink()) {
      if (!canonicalFiles.has(rel) && !credentials.includes(rel))
        refuse(rel, 'linked engine parent');
      return;
    }
    if (info.isDirectory()) {
      if (canonicalFiles.has(rel) || credentials.includes(rel))
        refuse(rel, 'engine leaf is a directory');
      for (const child of await fs.readdir(file)) await validateReserved(`${rel}/${child}`);
    } else if (!info.isFile() || canonicalDirs.has(rel) || directories.includes(rel)) {
      refuse(rel, 'invalid engine input shape');
    }
  };
  for (const dir of directories) await validateReserved(dir);
  for (const credential of credentials) await validateReserved(credential);

  const copy = async (source: string, root: string, rel: string, mode: number): Promise<void> => {
    await mkdir(root, path.dirname(rel));
    const destination = path.join(root, rel);
    const existing = await maybeStat(destination);
    if (existing?.isDirectory()) refuse(rel, 'file conflicts with directory');
    const temporary = path.join(
      path.dirname(destination),
      `.archon-transfer-${crypto.randomUUID()}`
    );
    // COPYFILE_EXCL creates an independent inode, even for a source hardlink.
    await fs.copyFile(source, temporary, constants.COPYFILE_EXCL);
    try {
      await own(temporary, mode);
      await fs.rename(temporary, destination);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  };
  if (publishing) {
    for (const dir of canonicalDirs) await mkdir(output, dir);
    for (const rel of canonicalFiles) {
      await copy(path.join(canonical, rel), output, rel, credentials.includes(rel) ? 0o600 : 0o644);
    }
    for (const rel of credentials) {
      if (canonicalFiles.has(rel)) continue;
      await checkParents(output, rel);
      await fs.rm(path.join(output, rel), { force: true });
    }
    return;
  }

  const resolveLeaf = async (file: string, seen = new Set<string>()): Promise<string> => {
    if (!inside(output, file)) refuse(file, 'link escapes output volume');
    await checkParents(output, path.relative(output, file));
    if (seen.has(file)) refuse(file, 'cyclic leaf link');
    seen.add(file);
    const info = await maybeStat(file);
    if (!info) return refuse(file, 'dangling leaf link');
    if (info.isSymbolicLink()) {
      const link = await fs.readlink(file);
      let target: string;
      if (path.isAbsolute(link)) {
        if (!inside(logicalRoot, link))
          refuse(file, 'absolute link escapes logical artifacts root');
        target = path.join(output, path.relative(logicalRoot, link));
      } else target = path.resolve(path.dirname(file), link);
      return resolveLeaf(target, seen);
    }
    if (!info.isFile()) refuse(file, 'output leaf must resolve to a regular file');
    return file;
  };
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const snapshot = async (rel: string): Promise<void> => {
    if (reserved(rel)) return;
    const file = path.join(output, rel);
    const info = await fs.lstat(file);
    if (info.isDirectory()) {
      dirs.add(rel);
      for (const child of await fs.readdir(file)) await snapshot(`${rel}/${child}`);
    } else {
      if (protectsDescendant(rel)) refuse(rel, 'file replaces an engine parent');
      files.set(rel, await resolveLeaf(file));
    }
  };
  for (const child of await fs.readdir(output)) await snapshot(child);

  for (const dir of dirs) {
    let current = canonical;
    for (const part of dir.split('/')) {
      current = path.join(current, part);
      const info = await maybeStat(current);
      if (info?.isSymbolicLink()) refuse(dir, 'canonical parent is a symlink');
      if (!info?.isDirectory()) break;
    }
  }

  const reconcile = async (rel: string): Promise<void> => {
    if (reserved(rel)) return;
    const file = path.join(canonical, rel);
    const info = await fs.lstat(file);
    const neededParent = protectsDescendant(rel);
    if (info.isDirectory()) {
      for (const child of await fs.readdir(file)) await reconcile(`${rel}/${child}`);
      if (!dirs.has(rel) && !neededParent) await fs.rmdir(file);
    } else if (!files.has(rel)) {
      if (neededParent) refuse(rel, 'canonical engine parent is not a directory');
      await fs.unlink(file);
    }
  };
  for (const child of await fs.readdir(canonical)) await reconcile(child);
  for (const dir of dirs) {
    const destination = path.join(canonical, dir);
    const info = await maybeStat(destination);
    if (info && !info.isDirectory()) await fs.unlink(destination);
    await mkdir(canonical, dir);
  }
  for (const [rel, source] of files) await copy(source, canonical, rel, 0o644);
}

export function buildArtifactTransferProgram(
  direction: TransferDirection,
  canonical: string,
  output: string,
  logicalRoot: string
): string {
  const options: TransferOptions = {
    direction,
    canonical,
    output,
    logicalRoot,
    directories: [NODES_SUBDIR, RUN_ARTIFACTS_ENGINE_SUBDIR],
    credentials: MANAGED_PROVIDER_CREDENTIAL_RELATIVE_PATHS,
  };
  return `await (${transferArtifacts.toString()})(${JSON.stringify(options)});`;
}
