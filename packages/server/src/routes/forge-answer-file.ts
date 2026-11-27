/**
 * The forge answers `GET /api/forge/subjects` keeps (issue titles and states, change merge
 * states), kept in one JSON file under the server's home as well, so a freshly started server
 * answers from what the last one learned instead of asking the forge once per card (DESIGN.md,
 * "Speed is a requirement"). Each entry keeps the time it was answered, so the route's own
 * freshness rules (`api.forge.ts`) still decide when to ask again: an old entry is served stale
 * while it refreshes.
 *
 * It is a display cache, not engine state: nothing the engine decides reads it, and losing it
 * costs only a slower first read. So a missing file is an empty cache, and a file that cannot be
 * read or parsed is an empty cache plus one warning naming it; an entry of a shape this server
 * does not know is skipped, and keys it does not know are ignored, so another binary's file
 * never breaks this one. A failed lookup (an issue the forge could not read, a change whose state
 * is unknown) is kept too, with its time: a restarted server shows it at once and asks again in
 * the background once its shorter life is over, instead of holding a read for a first lookup.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from '@hono/zod-openapi';
import type { ChangeMergeState, WorkItemAnswer } from '@archon/adapters/forge-host';
import { sanitizeCredentials } from '@archon/core/utils/credential-sanitizer';
import { getLog } from './api-route-kit';

/** One kept answer and when it settled, as the route's caches hold it. */
export interface Kept<T> {
  value: T;
  at: number;
}

/**
 * The most issue answers, and the most change answers, kept in memory and in the file. A
 * board shows a few hundred cards per project and a server serves a handful of projects, so
 * this is far above what a real install reads; it bounds what a caller naming endless distinct
 * URLs or issue numbers can make the server, and its file, hold.
 */
export const ISSUES_KEPT = 5000;
export const CHANGES_KEPT = 5000;

/**
 * Drops the oldest entries of `kept` past `most`. A Map iterates in insertion order, and every
 * writer keeps that order the order of last answer (`keepBounded`, and `boundByAge` on load).
 */
function trim<T>(kept: Map<string, Kept<T>>, most: number): void {
  for (const oldest of kept.keys()) {
    if (kept.size <= most) break;
    kept.delete(oldest);
  }
}

/** Keeps `entry` under `key` as the newest entry of `kept`, at most `most` kept. */
export function keepBounded<T>(
  kept: Map<string, Kept<T>>,
  key: string,
  entry: Kept<T>,
  most: number
): void {
  kept.delete(key);
  kept.set(key, entry);
  trim(kept, most);
}

/** Reorders `kept` oldest answer first, then keeps the newest `most`. */
function boundByAge<T>(kept: Map<string, Kept<T>>, most: number): void {
  const ordered = [...kept].sort(([, a], [, b]) => a.at - b.at);
  kept.clear();
  for (const [key, entry] of ordered) kept.set(key, entry);
  trim(kept, most);
}

const issueEntry = z.object({
  value: z.union([
    z.object({
      number: z.number().int().positive(),
      title: z.string(),
      state: z.enum(['open', 'closed']),
      url: z.string(),
    }),
    z.object({ number: z.number().int().positive(), unknown: z.string() }),
  ]),
  at: z.number(),
});

const changeEntry = z.object({
  value: z.object({
    url: z.string().nullable(),
    merged: z.union([z.boolean(), z.literal('unknown')]),
    mergedAt: z.string().nullable(),
    number: z.number().int().positive().nullable(),
    reason: z.string().optional(),
  }),
  at: z.number(),
});

const fileSchema = z.object({
  version: z.literal(1),
  issues: z.record(z.string(), z.unknown()).default({}),
  changes: z.record(z.string(), z.unknown()).default({}),
});

/** How long after the last new answer the file is written, so a cold board writes it once. */
const WRITE_DELAY_MS = 2_000;

export interface ForgeAnswerFile {
  issues: Map<string, Kept<WorkItemAnswer>>;
  changes: Map<string, Kept<ChangeMergeState>>;
  /** Fills both maps from the file, once; later calls return the same promise. */
  load: () => Promise<void>;
  /** A map gained an answer: write the file soon. */
  changed: () => void;
  /** Write now what is pending. Only tests call it: the server lets the timer write. */
  flush: () => Promise<void>;
}

function entries<T>(raw: Record<string, unknown>, schema: z.ZodType<Kept<T>>): [string, Kept<T>][] {
  return Object.entries(raw).flatMap(([key, entry]) => {
    const parsed = schema.safeParse(entry);
    return parsed.success ? [[key, parsed.data] as [string, Kept<T>]] : [];
  });
}

/**
 * The answer file at `where()`, asked for on first use: a server builds this while it registers
 * its routes, and registering reads nothing, not even where the home is.
 */
export function forgeAnswerFile(where: () => string): ForgeAnswerFile {
  let resolved: string | undefined;
  const at = (): string => (resolved ??= where());
  const issues = new Map<string, Kept<WorkItemAnswer>>();
  const changes = new Map<string, Kept<ChangeMergeState>>();
  let loading: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing: Promise<void> = Promise.resolve();

  const read = async (): Promise<void> => {
    const path = at();
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      getLog().warn({ err: error, path }, 'forge_answer_file_unreadable');
      return;
    }
    let parsed: z.infer<typeof fileSchema>;
    try {
      parsed = fileSchema.parse(JSON.parse(text));
    } catch (error) {
      // Intentional: a broken display cache starts empty rather than failing the route.
      getLog().warn({ err: error, path }, 'forge_answer_file_invalid');
      return;
    }
    // An answer a request already settled is newer than the file's.
    // An issue is keyed by its project's remote, which an older server kept with any
    // credentials it carried: the key is cleaned as the route cleans it, so the answer is
    // kept and the credentials are never written back (#286).
    for (const [stored, entry] of entries(parsed.issues, issueEntry)) {
      const key = sanitizeCredentials(stored);
      if (!issues.has(key)) issues.set(key, entry);
    }
    for (const [key, entry] of entries(parsed.changes, changeEntry))
      if (!changes.has(key)) changes.set(key, entry);
    // A file another server wrote may hold more than this one keeps: the newest are kept.
    boundByAge(issues, ISSUES_KEPT);
    boundByAge(changes, CHANGES_KEPT);
  };

  const write = async (): Promise<void> => {
    const body = JSON.stringify({
      version: 1,
      issues: Object.fromEntries(issues),
      changes: Object.fromEntries(changes),
    });
    const path = at();
    const temp = `${path}.${String(process.pid)}.tmp`;
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(temp, body);
      await rename(temp, path);
    } catch (error) {
      getLog().warn({ err: error, path }, 'forge_answer_file_write_failed');
    }
  };

  const flush = (): Promise<void> => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
      writing = writing.then(write);
    }
    return writing;
  };

  return {
    issues,
    changes,
    load: () => (loading ??= read()),
    changed: () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        writing = writing.then(write);
      }, WRITE_DELAY_MS);
      // A pending write never keeps the process alive.
      timer.unref?.();
    },
    flush,
  };
}
