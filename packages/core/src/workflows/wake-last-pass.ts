/**
 * What the wake watcher an install's job runs recorded about its latest pass: the one sign
 * of a watcher that runs but fails. The watcher writes it (`archon workflow wake --watch`
 * under the installed job); `trigger check`, `wake schedule status` and the server read it.
 *
 * Each loop of the watch records its own part; `ok` is false when any part failed.
 * `lastFailure` is this watcher's latest failed pass, kept after later passes succeed: a
 * long-running watch reuses what it read of an unchanged issue, so a label start it failed
 * to record fails one pass and then the passes after it report nothing.
 */
import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from '@hono/zod-openapi';
import { getArchonHome } from '@archon/paths';

const partSchema = z.object({ at: z.string(), ok: z.boolean(), errors: z.array(z.string()) });

// A persisted document older and newer binaries both read: unknown keys are dropped, not refused.
export const wakeLastPassSchema = z.object({
  at: z.string(),
  pid: z.number(),
  ok: z.boolean(),
  parts: z.object({ wake: partSchema.optional(), observe: partSchema.optional() }),
  lastFailure: z.object({ at: z.string(), errors: z.array(z.string()) }).optional(),
  /** The sources file the watcher loaded, so a reader can tell what the job observes. */
  sources: z.string().optional(),
});
export type WakeLastPass = z.infer<typeof wakeLastPassSchema>;

/** One wake job per install: its id is keyed on the Archon home. */
export function wakeJobId(archonHome = getArchonHome()): string {
  return `workflow-wake-${createHash('sha256').update(archonHome).digest('hex')}`;
}

/** Where a watcher that follows the installed job records its last pass. */
export function wakeLastPassPath(
  target: { id: string; archonHome: string } = { id: wakeJobId(), archonHome: getArchonHome() }
): string {
  return join(target.archonHome, 'schedules', `${target.id}.last-pass.json`);
}

/**
 * What the last-pass record says: `none` when no watcher has written one, `read` with the
 * pass, or `unreadable` with why, for a record that exists but cannot be read, is not JSON
 * or fails the schema. An unreadable record is not "no pass recorded": a reader that
 * conflated them would report a watcher that writes a broken record as one never run.
 */
export type WakeLastPassRead =
  | { kind: 'none' }
  | { kind: 'read'; pass: WakeLastPass }
  | { kind: 'unreadable'; reason: string };

/** The last pass recorded for the installed job (`WakeLastPassRead`). */
export async function readWakeLastPass(path = wakeLastPassPath()): Promise<WakeLastPassRead> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none' };
    return { kind: 'unreadable', reason: (error as Error).message };
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    return { kind: 'unreadable', reason: `not JSON: ${(error as Error).message}` };
  }
  const parsed = wakeLastPassSchema.safeParse(document);
  return parsed.success
    ? { kind: 'read', pass: parsed.data }
    : { kind: 'unreadable', reason: z.prettifyError(parsed.error) };
}

/** Replaces the record whole, so a reader never sees half of one. */
export async function writeWakeLastPass(path: string, pass: WakeLastPass): Promise<void> {
  const temporary = `${path}.${String(process.pid)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(pass)}\n`);
  await rename(temporary, path);
}
