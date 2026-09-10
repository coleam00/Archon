/**
 * The process contract every deterministic script in this pack shares.
 *
 * A node's `with:` bindings arrive as `INPUTS_<UPPER_SNAKE>` environment text and
 * are always strings: a bound boolean arrives as `"true"`/`"false"`, and a skipped
 * producer bound with `if_skipped: null` arrives as `"null"`. Nothing here
 * interprets those spellings — what a value means belongs to the script that knows
 * what it is for.
 *
 * Bun writes UTF-8 with `\n` line endings on every platform, so a terminal report
 * composed here is byte-identical wherever a run happens. The Python predecessors
 * had to pin both by hand at four call sites, because Windows Python wrote stdout
 * in the console code page and rewrote '\n' as '\r\n'.
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

/** A bound input, or the empty string when the binding is absent. */
export function input(name: string): string {
  return process.env[`INPUTS_${name}`] ?? '';
}

/** A bound input with surrounding whitespace removed. */
export function trimmedInput(name: string): string {
  return input(name).trim();
}

/**
 * A variable the engine supplies to every exec node. Its absence is a bug in the
 * engine or in the node's declaration, never a state a script should report on, so
 * this throws rather than substituting a default that would read or write
 * somewhere else.
 */
export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set; the engine supplies it to every exec node.`);
  }
  return value;
}

/** This run's artifact directory. */
export function artifactsDir(): string {
  return requiredEnv('ARTIFACTS_DIR');
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
export function report(text: string): void {
  console.log(text);
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
