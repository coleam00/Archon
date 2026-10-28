// ---------------------------------------------------------------------------
// In-process reader for the downloaded web UI archive.
//
// Extraction used to spawn `tar`, and on windows that child stalled for tens of
// seconds at random (#2924). Unpacking ~2 MB needs no process: this reads the
// gzipped tar that release.yml produces (GNU tar, default format) with the
// semantics of `tar xzf - --strip-components=1`. It understands files,
// directories and GNU long names, honors the POSIX ustar `prefix` field for our
// own test fixtures, and refuses every other entry type — links included — so a
// packaging change that starts emitting them fails loudly here instead of
// being extracted differently.
//
// Header checksums are not verified: the whole archive's SHA-256 is checked
// before it reaches this reader.
// ---------------------------------------------------------------------------

import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve, sep } from 'path';

const BLOCK = 512;
const decoder = new TextDecoder();

interface TarHeader {
  name: string;
  size: number;
  type: string;
}

/** A NUL-terminated string field. */
function field(block: Uint8Array, offset: number, width: number): string {
  const raw = block.subarray(offset, offset + width);
  const end = raw.indexOf(0);
  return decoder.decode(end === -1 ? raw : raw.subarray(0, end));
}

function readHeader(block: Uint8Array): TarHeader {
  const name = field(block, 0, 100);
  // Only POSIX ustar has a `prefix` field; GNU's magic ("ustar  ") reuses those bytes.
  const prefix = field(block, 257, 6) === 'ustar' ? field(block, 345, 155) : '';
  const fullName = prefix ? `${prefix}/${name}` : name;
  const sizeField = field(block, 124, 12).trim();
  const size = sizeField === '' ? 0 : Number.parseInt(sizeField, 8);
  if (!/^[0-7]*$/.test(sizeField) || !Number.isSafeInteger(size)) {
    throw new Error(`Invalid size "${sizeField}" for "${fullName}" in the web UI archive`);
  }
  // A NUL typeflag is a pre-POSIX regular file.
  const type = block[156] === 0 ? '0' : String.fromCharCode(block[156]);
  return { name: fullName, size, type };
}

/**
 * Where `name` lands under `targetDir` after stripping its first path component,
 * or undefined when nothing is left (the `./` or `web/` root). `.` counts as a
 * component, as it does for tar: `./index.html` becomes `index.html`.
 */
function entryTarget(targetDir: string, name: string): string | undefined {
  const refuse = (reason: string): never => {
    throw new Error(`Refusing web UI archive entry "${name}": ${reason}`);
  };
  if (name.startsWith('/')) refuse('absolute path');
  const segments = name.split('/').filter(segment => segment !== '');
  if (segments.includes('..')) refuse('path traversal');
  const rest = segments.slice(1);
  if (rest.length === 0) return undefined;
  const root = resolve(targetDir);
  const target = resolve(root, ...rest);
  // Catches what the segment checks cannot see, such as a windows drive letter
  // or a backslash that path.resolve treats as a separator on win32.
  if (!target.startsWith(root + sep)) refuse('resolves outside the target');
  return target;
}

function writeEntry(header: TarHeader, target: string, body: Uint8Array): void {
  try {
    if (header.type === '5') {
      mkdirSync(target, { recursive: true });
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body);
    }
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to extract "${header.name}" to ${target}: ${cause}`, { cause: err });
  }
}

/** Writes one file or directory entry; true when it wrote a file. */
function extractEntry(header: TarHeader, body: Uint8Array, targetDir: string): boolean {
  if (header.type !== '0' && header.type !== '5') {
    throw new Error(
      `Unsupported entry type '${header.type}' for "${header.name}" in the web UI archive`
    );
  }
  const target = entryTarget(targetDir, header.name);
  if (target === undefined) return false;
  writeEntry(header, target, body);
  return header.type === '0';
}

function gunzip(gzipped: Uint8Array<ArrayBuffer>): Uint8Array {
  try {
    return Bun.gunzipSync(gzipped);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read the web UI archive: ${cause}`, { cause: err });
  }
}

/**
 * Extract a gzipped tar into `targetDir` with `tar --strip-components=1`
 * semantics. Returns the number of files written.
 */
export function extractWebArchive(gzipped: Uint8Array<ArrayBuffer>, targetDir: string): number {
  const tar = gunzip(gzipped);
  let offset = 0;
  let longName: string | undefined;
  let files = 0;
  // An all-zero block or the end of data ends the archive, as it does for tar.
  while (offset + BLOCK <= tar.length) {
    const block = tar.subarray(offset, offset + BLOCK);
    if (block.every(byte => byte === 0)) break;
    const header = readHeader(block);
    if (longName !== undefined) header.name = longName;
    longName = undefined;
    const start = offset + BLOCK;
    if (start + header.size > tar.length) {
      throw new Error(`Web UI archive is truncated inside "${header.name}"`);
    }
    const body = tar.subarray(start, start + header.size);
    offset = start + Math.ceil(header.size / BLOCK) * BLOCK;
    if (header.type === 'L') {
      longName = field(body, 0, body.length);
      continue;
    }
    if (extractEntry(header, body, targetDir)) files++;
  }
  return files;
}
