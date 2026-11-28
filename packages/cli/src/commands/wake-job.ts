/**
 * What a `workflow wake --watch` started by the installed wake job knows about that job: the
 * job's definition file it follows, the sources file it loaded, and the record of its passes.
 * The job discards the watch's output, so this record is what `wake schedule status` and
 * `trigger check` read. A watch started with no job installed follows nothing and records
 * nothing.
 */
import { statSync } from 'node:fs';
import { nativeScheduleDefinition } from '../triggers/native-schedule';
import {
  wakeLastPassPath,
  writeWakeLastPass,
  type WakeLastPass,
} from '@archon/core/workflows/wake-last-pass';
import { workflowWakeScheduleTarget } from './wake-schedule';

/**
 * The wake job's definition file as this watch found it: its path and the file's identity.
 * `sources` is the sources file the watch loaded, when it names one, so an edit to it
 * restarts the watcher on the new configuration; `lastPass` is where each pass is recorded.
 */
export interface FollowedWakeJob {
  path: string;
  identity: string;
  sources?: { path: string; identity: string | undefined };
  lastPass: string;
}

/** Which file is at `path` now; a file written again in its place is another one. */
function fileIdentity(path: string): string | undefined {
  const found = statSync(path, { throwIfNoEntry: false });
  return found && `${String(found.ino)}:${String(found.mtimeMs)}:${String(found.ctimeMs)}`;
}

/**
 * The wake job's definition file, when the job is installed as this watch starts. Only
 * launchd stops a running watcher when its job is removed, so the watch stops itself once
 * that file is gone or is another file: `remove` deletes it, and an `install` after a
 * `remove` writes a new one, even before this watch next looks. A watch started with no job
 * installed has nothing to follow and never stops for this.
 */
export function followedWakeJob(watch: boolean): FollowedWakeJob | undefined {
  if (!watch) return undefined;
  const target = workflowWakeScheduleTarget();
  const path = nativeScheduleDefinition(target);
  const identity = path === undefined ? undefined : fileIdentity(path);
  if (path === undefined || identity === undefined) return undefined;
  const sources = process.env.ARCHON_WEBHOOK_SOURCES?.trim();
  return {
    path,
    identity,
    ...(sources ? { sources: { path: sources, identity: fileIdentity(sources) } } : {}),
    lastPass: wakeLastPassPath(target),
  };
}

/**
 * Why the watch must stop for its job: the job was removed or replaced, or the sources file
 * it loaded changed. The job starts a new watch on its interval, which loads the file again.
 */
export function wakeJobChange(
  job: FollowedWakeJob
): { reason: 'job removed' | 'job replaced' | 'sources changed'; definition: string } | undefined {
  const now = fileIdentity(job.path);
  if (now === undefined) return { reason: 'job removed', definition: job.path };
  if (now !== job.identity) return { reason: 'job replaced', definition: job.path };
  if (job.sources && fileIdentity(job.sources.path) !== job.sources.identity)
    return { reason: 'sources changed', definition: job.sources.path };
  return undefined;
}

/**
 * Records each loop's latest pass for the installed job. Nothing is recorded by a watch that
 * follows no job, nor once the job was removed or replaced, so a pass that ends after
 * `remove` leaves no record behind. A record that cannot be written never fails the pass.
 */
export function lastPassRecorder(
  job: FollowedWakeJob | undefined
): (part: 'wake' | 'observe', ok: boolean, errors: readonly string[]) => Promise<void> {
  const parts: WakeLastPass['parts'] = {};
  let lastFailure: WakeLastPass['lastFailure'];
  return async (part, ok, errors) => {
    if (job === undefined || fileIdentity(job.path) !== job.identity) return;
    const at = new Date().toISOString();
    parts[part] = { at, ok, errors: [...errors] };
    if (!ok) lastFailure = { at, errors: [...errors] };
    const pass: WakeLastPass = {
      at,
      pid: process.pid,
      ok: Object.values(parts).every(entry => entry?.ok !== false),
      parts,
      ...(lastFailure ? { lastFailure } : {}),
      ...(job.sources ? { sources: job.sources.path } : {}),
    };
    await writeWakeLastPass(job.lastPass, pass).catch(() => undefined);
  };
}

/**
 * A watch the job started that failed before its first pass, such as on a sources file that
 * does not load: recorded as a failed pass, or `status` would keep showing the last record a
 * healthy watcher wrote while every new one fails at start.
 */
export async function recordWakeStartFailure(error: string): Promise<void> {
  await lastPassRecorder(followedWakeJob(true))('observe', false, [error]);
}
