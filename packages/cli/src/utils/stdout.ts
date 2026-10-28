/**
 * Guaranteed-delivery writes for CLI output that must not be silently dropped.
 *
 * ## Why this exists
 *
 * When the CLI's stdout is a pipe (`archon ... --json | jq`), Bun opens fd 1 in
 * non-blocking mode. A `write(2)` larger than the pipe capacity (64 KiB on
 * macOS) then returns a SHORT count instead of writing everything, and
 * `console.log` discards the unwritten remainder without raising an error.
 * The result is silently truncated JSON with exit code 0 — see #2384.
 *
 * The loss happens at the moment `console.log` is called, not at process exit,
 * so no exit-path flush can recover it. The only fix is to not hand large
 * payloads to `console.log`: `process.stdout.write()` returns a stream-backed
 * completion callback that fires once every byte has reached the OS, retrying
 * short writes and `EAGAIN` through the event loop (no busy-wait).
 *
 * Redirecting to a regular file (`> out.json`) never reproduced the bug because
 * a regular-file fd stays blocking, so a single write always completes — that
 * asymmetry is the signature of this class of bug.
 */

function writeStream(stream: NodeJS.WriteStream, text: string | Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(text, error => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

/**
 * Write `text` to stdout and resolve only once the bytes have been handed to
 * the OS in full.
 *
 * @param text - Exact bytes or text to emit (include any trailing newline yourself).
 * @throws The underlying stream error if the write fails (e.g. EPIPE).
 */
export function writeStdout(text: string | Uint8Array): Promise<void> {
  return writeStream(process.stdout, text);
}

/**
 * The same guaranteed delivery for stderr.
 *
 * `console.error` is not equivalent for anything that has to arrive. Writing it
 * to a pipe whose reader has already gone is a SILENT no-op under Bun — no throw,
 * no error, exit 0 — measured with `bun … 2>&1 | head -c 1`, where the callback
 * below reports `EPIPE` on the same closed pipe. A line whose whole job is to tell
 * a host something cannot be allowed to disappear that way.
 *
 * @param text - Exact bytes to emit (include any trailing newline yourself).
 * @throws The underlying stream error if the write fails (e.g. EPIPE).
 */
export function writeStderr(text: string | Uint8Array): Promise<void> {
  return writeStream(process.stderr, text);
}

/**
 * Serialize `value` as pretty-printed JSON and write it to stdout as one
 * newline-terminated document, waiting for full delivery.
 *
 * Every `--json` CLI path must use this instead of
 * `console.log(JSON.stringify(...))` so a piped consumer can never receive a
 * truncated document.
 */
export function writeJsonLine(value: unknown): Promise<void> {
  return writeStdout(`${JSON.stringify(value, null, 2)}\n`);
}
