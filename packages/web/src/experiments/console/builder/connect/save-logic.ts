/**
 * Pure save/rename/issue logic for the connected builder route. No I/O here —
 * every function is a deterministic transform so it can be unit-tested without
 * `fetch`. `BuilderConnected.tsx` owns the actual skill calls and wires these in.
 */
import type { Issue } from '../types';
import { makeIssue } from '../validation/make-issue';
import { HttpError } from '../../lib/http';
import type { WorkflowSource, WorkflowSaveSource } from '../../skills/workflows';

/**
 * Map a failed `PUT`/`DELETE` (`HttpError`) into a single `source:'server'`
 * issue for the panel.
 *
 * `HttpError.bodySnippet` is apiError's JSON `{ error, detail? }` BUT truncated
 * at 200 chars, so `JSON.parse` may throw on a cut-off body — guard it and fall
 * back to the raw snippet.
 */
export function serverErrorToIssues(err: HttpError): Issue[] {
  let message = err.bodySnippet || `Save failed (${String(err.status)})`;
  try {
    const parsed = JSON.parse(err.bodySnippet) as { error?: string; detail?: string };
    if (parsed.error !== undefined && parsed.error !== '') {
      message =
        parsed.detail !== undefined && parsed.detail !== ''
          ? `${parsed.error}: ${parsed.detail}`
          : parsed.error;
    }
  } catch {
    /* truncated/non-JSON body — keep the raw snippet */
  }
  return [
    makeIssue({
      rule: 'server.validation',
      severity: 'error',
      source: 'server',
      message,
      path: {},
    }),
  ];
}

/**
 * Map the `errors[]` of a `POST /api/workflows/validate` response (HTTP 200 with
 * `valid:false`) into `source:'server'` issues. One issue per error string.
 */
export function serverValidationToIssues(errors: readonly string[]): Issue[] {
  return errors.map(message =>
    makeIssue({ rule: 'server.validation', severity: 'error', source: 'server', message, path: {} })
  );
}

/** The subset of issues that must block a save (severity `'error'`). */
export function blockingErrors(issues: readonly Issue[]): Issue[] {
  return issues.filter(i => i.severity === 'error');
}

/** Bundled workflows open read-only; everything else is editable in place. */
export function isReadOnlySource(source: WorkflowSource): boolean {
  return source === 'bundled';
}

/**
 * The write scope for a save. A `global` workflow saves back to global; a
 * `project` workflow stays project; a `bundled` (read-only) workflow saves as a
 * project override (Save-as).
 */
export function saveTargetFor(source: WorkflowSource): WorkflowSaveSource {
  return source === 'global' ? 'global' : 'project';
}

/**
 * Mirror of the server's `isValidCommandName` (command-validation.ts) — EXACTLY,
 * not a stricter kebab/alnum regex (Spike #4): reject only names containing `/`,
 * `\`, or `..`, empty names, or names starting with `.`. Dots mid-name (`a.b`)
 * are allowed because the server accepts them.
 */
export function isValidWorkflowName(name: string): boolean {
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return false;
  if (name === '' || name.startsWith('.')) return false;
  return true;
}

/** A planned rename: PUT the new name first, then DELETE the old one. */
export type RenamePlan =
  | { ok: true; steps: ['put', 'delete'] }
  | { ok: false; reason: 'collision' | 'invalid-name' | 'noop' };

/**
 * Decide whether a rename from `from` → `to` can proceed. Blocks an invalid
 * target name, a no-op (`to === from`), and a collision (`to` already exists in
 * `existingNames`). On success the steps are new-then-old so a failed delete
 * still leaves the authoritative new file on disk.
 */
export function planRename(input: {
  from: string;
  to: string;
  existingNames: readonly string[];
}): RenamePlan {
  const { from, to, existingNames } = input;
  if (!isValidWorkflowName(to)) return { ok: false, reason: 'invalid-name' };
  if (to === from) return { ok: false, reason: 'noop' };
  if (existingNames.includes(to)) return { ok: false, reason: 'collision' };
  return { ok: true, steps: ['put', 'delete'] };
}
