// ---------------------------------------------------------------------------
// In-process tar.gz fixture builder.
//
// downloadWebDist shells out to `tar xzf -`, so the fixture it is fed has to be
// a genuine gzipped tar — but BUILDING that fixture does not need a subprocess.
// Spawning `tar czf -` here used to make the beforeAll hook the one thing in
// this file that could hang on a child process, which is exactly how it failed
// on windows CI (#2306). Emitting the ~1.1 KB ustar archive directly is
// deterministic, platform-independent, and needs no `tar` on PATH.
// ---------------------------------------------------------------------------

/** Write ASCII into a fixed-width header field (NUL padding comes from the zeroed buffer). */
function writeField(header: Uint8Array, offset: number, value: string, width: number): void {
  header.set(new TextEncoder().encode(value).subarray(0, width), offset);
}

/** Write a ustar numeric field: zero-padded octal followed by a trailing NUL. */
function writeOctalField(header: Uint8Array, offset: number, value: number, width: number): void {
  writeField(header, offset, value.toString(8).padStart(width - 1, '0'), width - 1);
}

/** One 512-byte ustar header block. `typeflag` is '0' (file) or '5' (directory). */
function tarHeader(name: string, size: number, typeflag: '0' | '5', mode: number): Uint8Array {
  const header = new Uint8Array(512);
  writeField(header, 0, name, 100);
  writeOctalField(header, 100, mode, 8);
  writeOctalField(header, 108, 0, 8); // uid
  writeOctalField(header, 116, 0, 8); // gid
  writeOctalField(header, 124, size, 12);
  writeOctalField(header, 136, 0, 12); // mtime — fixed so the fixture is byte-stable
  header.fill(0x20, 148, 156); // checksum field reads as 8 spaces while summing
  header[156] = typeflag.charCodeAt(0);
  writeField(header, 257, 'ustar', 6); // magic (NUL-terminated by the zeroed buffer)
  writeField(header, 263, '00', 2); // version
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
 * all still produce an `index.html` and a `tar` exit 0; only comparing content
 * catches them.
 */
export const FIXTURE_INDEX_HTML = '<html>ok</html>';

/** `web/` + `web/index.html`, tarred and gzipped — the shape `archon serve` downloads. */
export function buildWebTarball(indexHtml: string): Uint8Array<ArrayBuffer> {
  const body = new TextEncoder().encode(indexHtml);
  const padding = new Uint8Array((512 - (body.length % 512)) % 512);
  return new Uint8Array(
    Bun.gzipSync(
      concatBytes([
        tarHeader('web/', 0, '5', 0o755),
        tarHeader('web/index.html', body.length, '0', 0o644),
        body,
        padding,
        new Uint8Array(1024), // two zero blocks terminate the archive
      ])
    )
  );
}
