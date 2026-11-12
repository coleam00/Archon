/**
 * Exit the CLI process after every fire-and-forget `writeStdout` write has
 * been drained to the OS.
 *
 * The pipe-safe `console.log` shim in `./safe-console.ts` delegates through
 * `writeStdout` and returns synchronously — bytes reach the OS via the
 * underlying stream callback, not synchronously. `process.exit()` does NOT
 * drain `process.stdout`'s pending writes, so a process that exits without
 * awaiting the shim's `flushPendingWrites()` will silently drop the tail of
 * queued stdout against a slow reader (the truncation the shim exists to
 * prevent — see R1 in the review report and #2400).
 *
 * Both `exitWithDrain` and `withDrainedExit` live here so `cli.ts`'s
 * top-level `main().then().catch()` chain and the `safe-console.test.ts`
 * R9 regression test fixture can share them: a regression that drops the
 * drain from `withDrainedExit` itself (e.g. removing the `flushPendingWrites()`
 * await) is caught by the fixture, since it calls this same helper. A
 * regression that instead bypasses `withDrainedExit` at the cli.ts call site
 * (e.g. swapping it for a direct `process.exit`) is caught by the separate
 * static-contract test, which reads `cli.ts` as text. See R9 / R12 in the
 * review report.
 */
import { consumeWriteError, flushPendingWrites } from './safe-console';

export const exitWithDrain = async (code: number): Promise<never> => {
  await flushPendingWrites();
  const writeError = consumeWriteError();
  if (writeError !== null) {
    // EPIPE (a reader that hung up, e.g. `archon … | head -c 100`) is
    // expected and needs no extra trail — the non-zero exit code below is
    // the correct signal. Any other write failure (e.g. ENOSPC) is
    // genuinely unexpected and would otherwise leave zero diagnostic trail,
    // since the patched `console.log` is fire-and-forget and never
    // re-throws — log it here, BEFORE the forced exit below, since
    // `process.exit()` terminates the process synchronously and nothing
    // after it runs. See R17 in the review report.
    if (writeError.code !== 'EPIPE') {
      console.error('Fatal error: failed to write output:', writeError.message);
    }
    // Any `process.stdout.write` failure captured by the patched `console.log`
    // must surface as a non-zero exit regardless of platform. Without this, a
    // Linux CI runner can schedule the unhandled-rejection handler after
    // `process.exit()` and silently lose the EPIPE — the writer exits 0 even
    // though the piped reader hung up before delivery completed.
    if (code === 0) {
      process.exit(1);
    }
  }
  process.exit(code);
};

/**
 * Run `main()` to completion, routing BOTH the resolved code (via
 * `exitWithDrain(code)`) and the fatal rejection (via `console.error` +
 * `exitWithDrain(1)`) through the same drain helper. This is the
 * single source of truth for the top-level `main().then().catch()`
 * chain shape that `cli.ts` uses and that the `safe-console.test.ts` R9
 * regression test fixture exercises.
 *
 * The chain wiring used to be duplicated as a string literal in two
 * places (cli.ts and the R9 fixture). Extracting it here makes a
 * regression that drops the drain from the catch arm only — e.g.
 * replacing `.catch(..., () => exitWithDrain(1))` with a direct
 * `process.exit(1)` — impossible without changing this module, which is
 * what the R9 test now catches. See R12 in the review report.
 */
export function withDrainedExit(main: () => Promise<number>): Promise<never> {
  return main()
    .then(exitWithDrain)
    .catch(async (error: unknown) => {
      // `main()` can reject with anything JS allows (not only `Error`
      // instances), so normalize before reading `.message`.
      const message = error instanceof Error ? error.message : String(error);
      console.error('Fatal error:', message);
      return exitWithDrain(1);
    });
}
