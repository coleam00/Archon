/**
 * Convention-based default-workflow dispatch.
 *
 * Decides what an inbound message MEANS for a conversation whose project is
 * listed in the global `dispatch:` table: run that project's default workflow,
 * or fall through to normal AI chat/routing.
 *
 * Kept deliberately pure and I/O-free: the
 * whole policy is decidable from the message text, the bound project's name,
 * the config table, and the configured sigil, so it is unit-testable without a
 * DB, an adapter, or a loaded config. Everything that needs I/O — reading the
 * config, resolving the codebase, resolving the workflow, running it — stays in
 * the caller. That is why the sigil arrives as a parameter rather than being
 * read from config here.
 */

/**
 * Default prefix that opts a single message OUT of dispatch and back into
 * normal AI chat/routing.
 *
 * The trailing space is part of the sigil, and is the point of it: `? how does
 * this work` escapes, while `?!`, `??`, or a bare `?typo` do not. Requiring a
 * separator makes the escape hatch deliberate — in an intake thread, a message
 * that merely happens to begin with a question mark is far more likely to be
 * content than an instruction to the router.
 *
 * Override per install with `dispatchSigil:` in `~/.archon/config.yaml`.
 */
export const DEFAULT_DISPATCH_SIGIL = '? ';

/**
 * Normalize a configured `dispatchSigil:` into the prefix to actually match.
 *
 * The value comes from YAML that is cast, not schema-validated, so a non-string
 * or an all-whitespace sigil falls back to the default instead of being used
 * as-is. That guard is load-bearing rather than cosmetic: `''.startsWith` and
 * `'   '` against a leading-trimmed message both match essentially everything,
 * so an empty sigil would route every message in every dispatched project to
 * the AI — silently disabling the feature install-wide with no error anywhere.
 *
 * The value is deliberately NOT trimmed. Trailing whitespace is significant —
 * it is exactly what makes the default `'? '` require a separator.
 */
export function resolveDispatchSigil(configured: string | undefined): string {
  return typeof configured === 'string' && configured.trim() ? configured : DEFAULT_DISPATCH_SIGIL;
}

/** What should happen to this message. */
export type DispatchDecision =
  /** Route normally (AI chat / router). `message` may have had the sigil stripped. */
  | { readonly kind: 'chat'; readonly message: string }
  /** Run the project's configured default workflow with `message` as its input. */
  | { readonly kind: 'workflow'; readonly workflowName: string; readonly message: string };

/**
 * Look up a project's default workflow in the `dispatch:` table.
 *
 * The table comes from YAML that is cast, not schema-validated, so both the map
 * and its values are checked defensively. Keys are matched exactly first, then
 * case-insensitively — exact mirrors `findCodebaseByName` (the SQL lookup every
 * other project-name resolution uses), and the case-insensitive pass keeps a
 * capitalization typo in hand-written YAML from silently disabling the whole
 * feature for that project.
 */
function lookupDefaultWorkflow(
  dispatch: Record<string, string> | undefined,
  codebaseName: string | undefined
): string | undefined {
  if (!dispatch || typeof dispatch !== 'object' || !codebaseName) return undefined;

  const exact = dispatch[codebaseName];
  if (typeof exact === 'string' && exact.trim()) return exact.trim();

  const lowered = codebaseName.toLowerCase();
  for (const [project, workflowName] of Object.entries(dispatch)) {
    if (
      project.toLowerCase() === lowered &&
      typeof workflowName === 'string' &&
      workflowName.trim()
    ) {
      return workflowName.trim();
    }
  }
  return undefined;
}

/**
 * Decide whether `message` should run the bound project's default workflow.
 *
 * Precedence, highest first:
 *   1. `/command`   — slash commands always route as they do today, untouched.
 *   2. unlisted project — normal AI chat/routing, message untouched.
 *   3. `? message`  — the sigil forces normal AI chat/routing for this message.
 *   4. otherwise    — the listed project's default workflow.
 *
 * The mapping is checked BEFORE the sigil, so the sigil only means anything in
 * a conversation that would otherwise dispatch. Checking it first would make
 * every install silently swallow a leading `?` even with no `dispatch:`
 * configured — a behavior change for threads this feature should not touch.
 *
 * @param message         Raw inbound message text.
 * @param codebaseName    Name of the project bound to the conversation, if any.
 *                        Undefined for unscoped conversations, which never dispatch.
 * @param dispatch        The global `dispatch:` table, if configured.
 * @param configuredSigil The global `dispatchSigil:`, if configured. Omitted or
 *                        unusable falls back to {@link DEFAULT_DISPATCH_SIGIL}.
 */
export function resolveDispatch(
  message: string,
  codebaseName: string | undefined,
  dispatch: Record<string, string> | undefined,
  configuredSigil?: string
): DispatchDecision {
  const trimmed = message.trim();

  // 1. Slash commands are unchanged — including the non-deterministic ones the
  //    caller forwards to the AI, which must keep reaching it.
  if (trimmed.startsWith('/')) return { kind: 'chat', message };

  // 2. Not a dispatched project — nothing to intercept, and nothing to escape
  //    from, so the message passes through byte-for-byte.
  const workflowName = lookupDefaultWorkflow(dispatch, codebaseName);
  if (!workflowName) return { kind: 'chat', message };

  // 3. Sigil escape. Matched against the message with only its LEADING
  //    whitespace stripped, never the fully trimmed form: a sigil that ends in
  //    a separator (the default `'? '` does) can never prefix a string whose
  //    trailing whitespace has already been removed, so trimming first would
  //    make the default sigil unmatchable for a sigil-only message.
  //
  //    The sigil is consumed so the AI sees the real question; a sigil with
  //    nothing after it would strip to nothing, so pass the original through
  //    instead of handing the AI an empty prompt.
  const sigil = resolveDispatchSigil(configuredSigil);
  const leading = message.replace(/^\s+/, '');
  if (leading.startsWith(sigil)) {
    const stripped = leading.slice(sigil.length).trim();
    return { kind: 'chat', message: stripped || message };
  }

  // 4. Plain message in a dispatched project → its default workflow.
  return { kind: 'workflow', workflowName, message };
}
