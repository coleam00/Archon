/**
 * Host commands the script API has no function for: launching a run, cleanup, and
 * reading runs. Everything else the pack asks of the host goes through `archon:script`.
 */

import { isObject } from './inputs.ts';

/** The host's `archon` argv, as the CLI and server publish it to every exec node. */
export function archonCommand(): readonly string[] {
  const value = process.env.ARCHON_CLI_COMMAND;
  if (value === undefined || value === '') {
    throw new Error(
      'ARCHON_CLI_COMMAND is not set; the host that started this run did not publish its CLI command'
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('ARCHON_CLI_COMMAND is not a JSON string array');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every(part => typeof part === 'string' && part !== '')
  ) {
    throw new Error('ARCHON_CLI_COMMAND must be a non-empty JSON string array');
  }
  return parsed as string[];
}

/** The JSON object a host command prints; a failed command or any other output throws. */
function hostJson(args: readonly string[]): Record<string, unknown> {
  const result = Bun.spawnSync([...archonCommand(), ...args], { env: process.env, stdout: 'pipe', stderr: 'pipe' });
  let value: unknown;
  try {
    value = JSON.parse(result.stdout.toString());
  } catch {
    value = undefined;
  }
  if (result.exitCode !== 0 || !isObject(value)) {
    const error = isObject(value) && typeof value.error === 'string' ? `: ${value.error}` : '';
    throw new Error(`archon ${args.slice(0, 2).join(' ')} failed (exit ${String(result.exitCode)})${error}`);
  }
  return value;
}

/** The Archon user a run was started as or for, as `archon workflow get` reports it; null when it records none. */
export function runUser(runId: string): string | null {
  const user = hostJson(['workflow', 'get', runId, '--json']).user_id;
  return typeof user === 'string' && user !== '' ? user : null;
}

/**
 * This project's runs, newest first, as `archon workflow runs --json` lists them.
 * Refuses a listing that fell back to every project's runs: draining another
 * project's runs into this repository would be a wrong write, not a wider read.
 */
export function listRuns(limit: number): Record<string, unknown>[] {
  const value = hostJson(['workflow', 'runs', '--json', '--limit', String(limit)]);
  if (!Array.isArray(value.runs)) throw new Error('archon workflow runs listed no runs');
  if (value.scopeFallback === true) {
    throw new Error('archon workflow runs could not scope the listing to this project');
  }
  return value.runs.filter(isObject);
}
