/**
 * A tar reader that reports every entry's type.
 *
 * `Bun.Archive` cannot be used for plugin trees: it silently drops symlinks and
 * hard links and rewrites `../` and absolute names to stay inside the target.
 * An installer built on it would install a pack with files missing, or in the
 * wrong place, and report success. Reading the headers here lets the installer
 * refuse those entries by name instead.
 *
 * Handles the formats `git archive` (and so GitHub's codeload tarballs) writes:
 * ustar headers, pax extended (`x`) and global (`g`) headers, and GNU long
 * names (`L`).
 */

const BLOCK = 512;
const decoder = new TextDecoder();

export interface TarEntry {
  /** The archived name, `/`-separated, without a trailing `/`. */
  path: string;
  kind: 'file' | 'directory' | 'symlink' | 'hardlink' | 'other';
  /** File contents; empty for every other kind. */
  data: Uint8Array;
  /** Any execute bit set, which `git archive` records for executable files. */
  executable: boolean;
}

function text(block: Uint8Array, start: number, length: number): string {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return decoder.decode(end === -1 ? field : field.subarray(0, end));
}

function octal(block: Uint8Array, start: number, length: number): number {
  const raw = text(block, start, length).trim();
  if (!/^[0-7]*$/.test(raw)) throw new Error('Corrupt tar header: a numeric field is not octal');
  return raw === '' ? 0 : Number.parseInt(raw, 8);
}

/** `<length> <key>=<value>\n` records; only `path` changes what this reader returns. */
function paxPath(data: Uint8Array): string | undefined {
  let path: string | undefined;
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(decoder.decode(data.subarray(offset, space)), 10);
    if (!Number.isInteger(length) || length <= 0) throw new Error('Corrupt pax header');
    const record = decoder.decode(data.subarray(space + 1, offset + length - 1));
    const equals = record.indexOf('=');
    if (record.slice(0, equals) === 'path') path = record.slice(equals + 1);
    offset += length;
  }
  return path;
}

function kindOf(typeflag: string): TarEntry['kind'] {
  if (typeflag === '0' || typeflag === '\0' || typeflag === '7') return 'file';
  if (typeflag === '5') return 'directory';
  if (typeflag === '2') return 'symlink';
  if (typeflag === '1') return 'hardlink';
  return 'other';
}

export function readTar(tar: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let nextPath: string | undefined;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every(byte => byte === 0)) break;
    const size = octal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156]);
    const dataStart = offset + BLOCK;
    if (dataStart + size > tar.length) throw new Error('Truncated tar archive');
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (typeflag === 'x') {
      nextPath = paxPath(data) ?? nextPath;
      continue;
    }
    if (typeflag === 'L') {
      nextPath = text(data, 0, data.length);
      continue;
    }
    // Global pax records (git archive stores the commit there) and GNU long
    // link targets name no entry of their own.
    if (typeflag === 'g' || typeflag === 'K') continue;

    const prefix = text(header, 257, 6) === 'ustar' ? text(header, 345, 155) : '';
    const name = text(header, 0, 100);
    const path = nextPath ?? (prefix ? `${prefix}/${name}` : name);
    nextPath = undefined;
    const kind = kindOf(typeflag);
    entries.push({
      path: path.replace(/\/+$/, ''),
      kind,
      data: kind === 'file' ? data : new Uint8Array(0),
      executable: (octal(header, 100, 8) & 0o111) !== 0,
    });
  }
  return entries;
}
