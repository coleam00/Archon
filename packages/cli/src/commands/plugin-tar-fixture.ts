/**
 * Writes the ustar/pax archives the plugin tests need, including entries
 * `git archive` never produces (escaping names, hard links), so the installer's
 * refusals can be exercised. Test support only.
 */

export interface FixtureEntry {
  path: string;
  data?: string;
  /** ustar typeflag: '0' file (default), '1' hard link, '2' symlink, '5' directory. */
  type?: '0' | '1' | '2' | '5';
  link?: string;
  mode?: number;
}

const encoder = new TextEncoder();

function put(block: Uint8Array, offset: number, value: string): void {
  block.set(encoder.encode(value), offset);
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width, '0')}\0`;
}

function header(name: string, size: number, type: string, link: string, mode: number): Uint8Array {
  const block = new Uint8Array(512);
  put(block, 0, name);
  put(block, 100, octal(mode, 7));
  put(block, 108, octal(0, 7));
  put(block, 116, octal(0, 7));
  put(block, 124, octal(size, 11));
  put(block, 136, octal(0, 11));
  put(block, 148, '        ');
  put(block, 156, type);
  put(block, 157, link);
  put(block, 257, 'ustar\0');
  put(block, 263, '00');
  const sum = block.reduce((total, byte) => total + byte, 0);
  put(block, 148, `${sum.toString(8).padStart(6, '0')}\0 `);
  return block;
}

function padded(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(data.length / 512) * 512);
  out.set(data);
  return out;
}

/** A pax `path=` record; its decimal length prefix counts itself, in UTF-8 bytes. */
function paxRecord(path: string): Uint8Array {
  const body = ` path=${path}\n`;
  const bytes = (text: string): number => encoder.encode(text).length;
  let length = bytes(body) + 1;
  while (bytes(`${length}${body}`) !== length) length += 1;
  return encoder.encode(`${length}${body}`);
}

export function tarGz(entries: readonly FixtureEntry[]): Uint8Array<ArrayBuffer> {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const type = entry.type ?? '0';
    const data = type === '0' ? encoder.encode(entry.data ?? '') : new Uint8Array(0);
    let name = entry.path;
    if (encoder.encode(name).length > 100) {
      const record = paxRecord(name);
      blocks.push(header('././@PaxHeader', record.length, 'x', '', 0o644), padded(record));
      name = name.slice(0, 100);
    }
    blocks.push(header(name, data.length, type, entry.link ?? '', entry.mode ?? 0o644));
    blocks.push(padded(data));
  }
  blocks.push(new Uint8Array(1024));
  const tar = new Uint8Array(blocks.reduce((total, block) => total + block.length, 0));
  let offset = 0;
  for (const block of blocks) {
    tar.set(block, offset);
    offset += block.length;
  }
  return Bun.gzipSync(tar);
}
