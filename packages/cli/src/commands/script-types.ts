/**
 * `archon script types`: the declaration of the `archon:script` module, for an editor
 * or `tsc` over a pack's scripts. The text is embedded in the engine, so the file a
 * binary writes describes exactly the module that binary gives a script.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { scriptApiDeclaration } from '@archon/workflows/script-api';
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

async function report(status: Status, path: string, out: string, json: boolean): Promise<void> {
  if (json) {
    await writeJsonLine({ ok: status !== 'stale', path, status });
  } else if (status === 'stale') {
    console.error(
      `Error: ${path} is missing or stale. Run 'archon script types --out ${out}' to write it.`
    );
  } else {
    const verb = { written: 'Wrote', unchanged: 'Unchanged:', current: 'Up to date:' }[status];
    await writeStdout(`${verb} ${path}\n`);
  }
}

export async function scriptTypesCommand(
  cwd: string,
  options: { out?: string; check?: boolean; json?: boolean }
): Promise<number> {
  if (options.out === undefined) {
    if (options.check || options.json) {
      console.error('Usage: archon script types --out <file> [--check]');
      return 1;
    }
    await writeStdout(scriptApiDeclaration);
    return 0;
  }
  const path = resolve(cwd, options.out);
  // A checkout that converts line endings hands the file back with CRLF; compare on LF.
  const same = (await readIfPresent(path))?.replaceAll('\r\n', '\n') === scriptApiDeclaration;
  const written: Status = same ? 'unchanged' : 'written';
  const checked: Status = same ? 'current' : 'stale';
  const status = options.check ? checked : written;
  if (status === 'written') {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, scriptApiDeclaration);
  }
  await report(status, path, options.out, options.json === true);
  return status === 'stale' ? 1 : 0;
}
