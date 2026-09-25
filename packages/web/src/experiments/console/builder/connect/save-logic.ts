/**
 * Pure save/rename/issue logic for the connected builder route. No I/O here —
 * every function is a deterministic transform so it can be unit-tested without
 * `fetch`. `BuilderConnected.tsx` owns the actual skill calls and wires these in.
 */
import type { Issue } from '../types';
import { makeIssue } from '../validation/make-issue';
import { HttpError, serverErrorMessage } from '../../lib/http';
import type { WorkflowSaveSource } from '../../skills/workflows';

/** A client-side instant error for the panel (name validation, save gate). */
export function clientIssue(rule: string, message: string): Issue {
  return makeIssue({ rule, severity: 'error', source: 'client-instant', message, path: {} });
}

/** A server-tier error issue for the panel. */
function serverIssue(rule: string, message: string): Issue {
  return makeIssue({ rule, severity: 'error', source: 'server', message, path: {} });
}

/**
 * Map a failed `PUT`/`DELETE` (`HttpError`) into a single `source:'server'`
 * issue for the panel.
 */
export function serverErrorToIssues(err: HttpError): Issue[] {
  return [serverIssue('server.validation', serverErrorMessage(err))];
}

/**
 * Map the `errors[]` of a `POST /api/workflows/validate` response (HTTP 200 with
 * `valid:false`) into `source:'server'` issues. One issue per error string.
 */
export function serverValidationToIssues(errors: readonly string[]): Issue[] {
  return errors.map(message => serverIssue('server.validation', message));
}

/**
 * Issues for a rejected server validation. Guarantees at least one issue so the
 * panel is never silently cleared when the server returns `valid:false` with no
 * `errors` — otherwise Save/Rename would re-enable with no explanation.
 */
export function validationFailureToIssues(errors: readonly string[] | undefined): Issue[] {
  const issues = serverValidationToIssues(errors ?? []);
  if (issues.length > 0) return issues;
  return [
    serverIssue(
      'server.validation',
      'The server rejected the workflow but returned no error details.'
    ),
  ];
}

/** Map a thrown error to panel issues: HttpError → server detail, else a fallback. */
export function errorToIssues(e: unknown, rule: string, fallback: string): Issue[] {
  if (e instanceof HttpError) return serverErrorToIssues(e);
  return [serverIssue(rule, e instanceof Error ? e.message : fallback)];
}

/** The subset of issues that must block a save (severity `'error'`). */
export function blockingErrors(issues: readonly Issue[]): Issue[] {
  return issues.filter(i => i.severity === 'error');
}

/**
 * Bundled workflows open read-only; everything else is editable in place. The
 * parameter is widened to `string` so an unrecognised `Workflow.source` (#2578,
 * `WorkflowSource | (string & {})`) can pass through without a cast at the
 * call site — the comparison is the same `=== 'bundled'` either way.
 */
export function isReadOnlySource(source: string): boolean {
  return source === 'bundled';
}

/**
 * The write scope for a save. A `global` workflow saves back to global; a
 * `project` workflow stays project; a `bundled` (read-only) workflow saves as a
 * project override (Save-as). The parameter is widened to `string` for the
 * same reason `isReadOnlySource` is (#2578): an unrecognised source is not
 * `global`, so it falls to `'project'`, which is the "most permissive"
 * interpretation the issue explicitly defends.
 */
export function saveTargetFor(source: string): WorkflowSaveSource {
  return source === 'global' ? 'global' : 'project';
}

/**
 * Mirror of the server's `isValidCommandName` (`command-validation.ts`) —
 * EXACTLY, not a stricter kebab/alnum regex: reject only names containing `/`,
 * `\`, or `..`, empty names, or names starting with `.`. Dots mid-name (`a.b`)
 * are allowed because the server accepts them.
 */
export function isValidWorkflowName(name: string): boolean {
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return false;
  if (name === '' || name.startsWith('.')) return false;
  return true;
}

/** Human-readable reason for a blocked rename / rejected new name. */
export function renameReasonMessage(
  reason: 'collision' | 'invalid-name' | 'noop',
  to: string
): string {
  switch (reason) {
    case 'collision':
      return `A workflow named "${to}" already exists in this project.`;
    case 'invalid-name':
      return `"${to}" is not a valid workflow name (no "/", "\\", "..", leading dot, or empty).`;
    case 'noop':
      return 'The new name is the same as the current one.';
  }
}

/** A planned rename decision. On success the caller PUTs the new name, then DELETEs the old. */
export type RenamePlan =
  | { ok: true }
  | { ok: false; reason: 'collision' | 'invalid-name' | 'noop' };

/**
 * Decide whether a rename from `from` → `to` can proceed. Blocks an invalid
 * target name, a no-op (`to === from`), and a collision (`to` already exists in
 * `existingNames`). The caller executes new-then-old so a failed delete still
 * leaves the authoritative new file on disk.
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
  return { ok: true };
}
