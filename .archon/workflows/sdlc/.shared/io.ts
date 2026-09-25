/**
 * The process contract every deterministic script in this pack shares.
 *
 * A node's `with:` bindings arrive as `INPUTS_<UPPER_SNAKE>` environment text and
 * are always strings: a bound boolean arrives as `"true"`/`"false"`, and a skipped
 * producer bound with `if_skipped: null` arrives as `"null"`. Nothing here
 * interprets those spellings — what a value means belongs to the script that knows
 * what it is for.
 *
 * Read every binding as a literal `process.env.INPUTS_<NAME>` at its own call site
 * and pass the value in. The engine scans each script's source at workflow load and
 * refuses a workflow whose script reads a binding no `with:` clause or declared
 * input provides. It matches the literal form only, and it reads the entry script
 * alone, never its imports — so a helper that composed the key from a name would
 * hide every read in this pack from that check.
 *
 * Bun writes UTF-8 with `\n` line endings on every platform, so a terminal report
 * composed here is byte-identical wherever a run happens. Nothing in this pack needs
 * to pin either by hand.
 */

/**
 * Never call `process.exit()` in a packaged script.
 *
 * Bun 1.4.2 exits without draining stdout: a 500 KB write to a pipe arrives as
 * exactly 131072 bytes, silently. A truncated terminal report reads as a complete
 * one, and a truncated JSON document fails its node's certification with a message
 * about the schema rather than about the truncation. Setting `process.exitCode` and
 * returning lets the runtime flush before it leaves, which is why every helper here
 * sets the code instead of forcing the exit.
 */
function setFailed(): void {
  process.exitCode = 1;
}

/** A bound input's value, or the empty string when the binding is absent. */
export function text(value: string | undefined): string {
  return value ?? '';
}

/** A bound input's value with surrounding whitespace removed. */
export function trimmed(value: string | undefined): string {
  return (value ?? '').trim();
}

/**
 * This run's artifact directory.
 *
 * The engine supplies it to every exec node, so its absence is a bug in the engine
 * or in the node's declaration rather than a state a script should report on. This
 * throws instead of substituting a default that would read or write somewhere else.
 */
export function artifactsDir(): string {
  const value = process.env.ARTIFACTS_DIR;
  if (value === undefined || value === '') {
    throw new Error('ARTIFACTS_DIR is not set; the engine supplies it to every exec node.');
  }
  return value;
}

/**
 * The node's result: one strict JSON document on stdout.
 *
 * A node that declares `output_format` gets exactly one attempt — no fence
 * stripping, no repair pass, no reask — so this is the only way a certified script
 * writes its result.
 */
export function emit(value: unknown): void {
  console.log(JSON.stringify(value));
}

/** A plain-text result, for a node that declares no schema. */
export function report(value: string): void {
  console.log(value);
}

/**
 * The node's refusal: the reason on stderr, a non-zero exit, nothing on stdout.
 *
 * The engine broadcasts stderr to the operator as the run happens and retains it on
 * the `node_failed` event, so the message is the whole diagnostic.
 */
export function refuse(message: string): void {
  console.error(message);
  setFailed();
}

/**
 * A note the operator should see from a node that is not failing.
 *
 * Stderr reaches the operator even on the success path, which is what keeps a gate
 * that deliberately passed red loud rather than silent.
 */
export function note(message: string): void {
  console.error(message);
}
