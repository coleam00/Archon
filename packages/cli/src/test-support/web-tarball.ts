// ---------------------------------------------------------------------------
// In-process tar.gz fixture builder.
//
// downloadWebDist feeds the downloaded archive to an in-process tar reader, so
// its fixtures have to be genuine gzipped tars. Building them in-process keeps
// test setup free of child processes — spawning `tar czf -` here once hung a
// beforeAll hook on windows CI (#2306) — and lets a test choose the header
// format: POSIX ustar like `buildWebTarball`, or GNU like release.yml emits.
// ---------------------------------------------------------------------------

/** Write ASCII into a fixed-width header field (NUL padding comes from the zeroed buffer). */
function writeField(header: Uint8Array, offset: number, value: string, width: number): void {
  header.set(new TextEncoder().encode(value).subarray(0, width), offset);
}

/** Write a ustar numeric field: zero-padded octal followed by a trailing NUL. */
function writeOctalField(header: Uint8Array, offset: number, value: number, width: number): void {
  writeField(header, offset, value.toString(8).padStart(width - 1, '0'), width - 1);
}

export type TarFormat = 'ustar' | 'gnu';

interface HeaderFields {
  name: string;
  size: number;
  typeflag: string;
  mode: number;
  linkname?: string;
  format?: TarFormat;
}

/** One 512-byte header block. Names longer than 100 bytes are truncated here. */
function tarHeader({
  name,
  size,
  typeflag,
  mode,
  linkname = '',
  format = 'ustar',
}: HeaderFields): Uint8Array {
  const header = new Uint8Array(512);
  writeField(header, 0, name, 100);
  writeOctalField(header, 100, mode, 8);
  writeOctalField(header, 108, 0, 8); // uid
  writeOctalField(header, 116, 0, 8); // gid
  writeOctalField(header, 124, size, 12);
  writeOctalField(header, 136, 0, 12); // mtime — fixed so the fixture is byte-stable
  header.fill(0x20, 148, 156); // checksum field reads as 8 spaces while summing
  header[156] = typeflag.charCodeAt(0);
  writeField(header, 157, linkname, 100);
  if (format === 'ustar') {
    writeField(header, 257, 'ustar', 6); // magic (NUL-terminated by the zeroed buffer)
    writeField(header, 263, '00', 2); // version
  } else {
    writeField(header, 257, 'ustar  ', 8); // GNU magic + version: "ustar  \0"
  }
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeField(header, 148, checksum.toString(8).padStart(6, '0'), 6);
  header[154] = 0x00;
  header[155] = 0x20;
  return header;
}

/** Concatenate blocks into one buffer. */
function concatBytes(blocks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = blocks.reduce((sum, block) => sum + block.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
}

/**
 * The exact bytes the fixture claims to carry. Every test that extracts asserts
 * the file lands with THIS content, not merely that a file exists — a hand-rolled
 * binary format that nothing validates is a worse trap than the hang it replaced.
 * A `size` field short by a few bytes, dropped padding, or a missing terminator
 * all still produce an `index.html` and a clean extraction; only comparing content
 * catches them.
 */
export const FIXTURE_INDEX_HTML = '<html>ok</html>';

export interface TarEntry {
  name: string;
  type: 'file' | 'dir' | 'symlink';
  body?: string;
  linkname?: string;
}

const TYPEFLAGS = { file: '0', dir: '5', symlink: '2' } as const;

/** A header's payload, zero-padded to whole blocks. */
function padded(body: Uint8Array): Uint8Array[] {
  return [body, new Uint8Array((512 - (body.length % 512)) % 512)];
}

function entryBlocks(entry: TarEntry, format: TarFormat): Uint8Array[] {
  const encoder = new TextEncoder();
  const blocks: Uint8Array[] = [];
  const nameBytes = encoder.encode(entry.name);
  if (format === 'gnu' && nameBytes.length > 100) {
    // GNU long name: a `././@LongLink` entry whose payload is the full name.
    const longName = concatBytes([nameBytes, new Uint8Array(1)]);
    const fields = { size: longName.length, typeflag: 'L', mode: 0o644, format };
    blocks.push(tarHeader({ name: '././@LongLink', ...fields }), ...padded(longName));
  }
  const body = encoder.encode(entry.body ?? '');
  blocks.push(
    tarHeader({
      name: entry.name,
      size: body.length,
      typeflag: TYPEFLAGS[entry.type],
      mode: entry.type === 'file' ? 0o644 : 0o755,
      linkname: entry.linkname,
      format,
    }),
    ...padded(body)
  );
  return blocks;
}

/** A gzipped tar of `entries` in the given header format. */
export function buildTarGz(entries: TarEntry[], format: TarFormat): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    Bun.gzipSync(
      concatBytes([
        ...entries.flatMap(entry => entryBlocks(entry, format)),
        new Uint8Array(1024), // two zero blocks terminate the archive
      ])
    )
  );
}

/** `web/` + `web/index.html`, tarred and gzipped — the shape `archon serve` downloads. */
export function buildWebTarball(indexHtml: string): Uint8Array<ArrayBuffer> {
  return buildTarGz(
    [
      { name: 'web/', type: 'dir' },
      { name: 'web/index.html', type: 'file', body: indexHtml },
    ],
    'ustar'
  );
}
