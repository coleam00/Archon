/**
 * `archon script types` and `archon script preload`: the declaration of the `archon:script`
 * module, for an editor or `tsc` over a pack's scripts, and the preload file that makes the
 * module importable in a script or test run outside the engine. Both texts are embedded in
 * the engine, so the files a binary writes are exactly what that binary gives a script.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { scriptApiDeclaration, scriptApiPreloadSource } from '@archon/workflows/script-api';
import { writeJsonLine, writeStdout } from '../utils/stdout';

type Status = 'written' | 'unchanged' | 'current' | 'stale';

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

type Subcommand = 'types' | 'preload';
interface ScriptFileOptions {
  out?: string;
  check?: boolean;
  json?: boolean;
}

async function report(
  subcommand: Subcommand,
  status: Status,
  path: string,
  out: string,
  json: boolean
): Promise<void> {
  if (json) {
    await writeJsonLine({ ok: status !== 'stale', path, status });
  } else if (status === 'stale') {
    console.error(
      `Error: ${path} is missing or stale. Run 'archon script ${subcommand} --out ${out}' to write it.`
    );
  } else {
    const verb = { written: 'Wrote', unchanged: 'Unchanged:', current: 'Up to date:' }[status];
    await writeStdout(`${verb} ${path}\n`);
  }
}

export async function scriptTypesCommand(cwd: string, options: ScriptFileOptions): Promise<number> {
  if (options.out === undefined) {
    if (options.check || options.json) {
      console.error('Usage: archon script types --out <file> [--check]');
      return 1;
    }
    await writeStdout(scriptApiDeclaration);
    return 0;
  }
  return writeEmbeddedText('types', scriptApiDeclaration, cwd, options.out, options);
}

export async function scriptPreloadCommand(
  cwd: string,
  options: ScriptFileOptions
): Promise<number> {
  if (options.out === undefined) {
    console.error('Usage: archon script preload --out <file> [--check]');
    return 1;
  }
  return writeEmbeddedText('preload', scriptApiPreloadSource, cwd, options.out, options);
}

async function writeEmbeddedText(
  subcommand: Subcommand,
  text: string,
  cwd: string,
  out: string,
  options: ScriptFileOptions
): Promise<number> {
  const path = resolve(cwd, out);
  // A checkout that converts line endings hands the file back with CRLF; compare on LF.
  const same = (await readIfPresent(path))?.replaceAll('\r\n', '\n') === text;
  const written: Status = same ? 'unchanged' : 'written';
  const checked: Status = same ? 'current' : 'stale';
  const status = options.check ? checked : written;
  if (status === 'written') {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
  await report(subcommand, status, path, out, options.json === true);
  return status === 'stale' ? 1 : 0;
}
