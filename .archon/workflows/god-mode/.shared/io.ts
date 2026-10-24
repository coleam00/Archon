/**
 * The process contract every god-mode script shares.
 *
 * Bound inputs arrive as `INPUTS_<UPPER_SNAKE>` environment text. Read each one as a
 * literal `process.env.INPUTS_<NAME>` in the entry script: the engine scans the entry
 * script's source at load and refuses a workflow whose script reads a binding nothing
 * provides, and it cannot see a key composed inside a helper.
 *
 * Never call `process.exit()`: Bun can exit before stdout drains, and a truncated JSON
 * document then fails certification with a misleading schema error. Set the exit code
 * and return instead.
 */

export function text(value: string | undefined): string {
  return value ?? '';
}

/** A bound JSON value; empty text and the literal `null` both read as null. */
export function json(value: string | undefined): unknown {
  const raw = (value ?? '').trim();
  return raw === '' || raw === 'null' ? null : (JSON.parse(raw) as unknown);
}

/** The node's single structured output document. */
export function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** Fail the node with a message that names what was refused. */
export function refuse(message: string): void {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

/** Run an entry script's `main`, turning any throw into a named refusal. */
export function run(label: string, main: () => void): void {
  try {
    main();
  } catch (error) {
    refuse(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
