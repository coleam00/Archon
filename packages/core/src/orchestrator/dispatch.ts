/**
 * Pure, I/O-free policy for `defaultWorkflows:` — decides what an inbound
 * message means for a conversation whose project is listed in the global
 * `defaultWorkflows:` table: run that project's workflow, or bypass to normal
 * AI chat/routing.
 *
 * Kept I/O-free so the whole decision is a function of the message text, the
 * bound project's name, the config table, and the configured bypass prefix —
 * unit-testable without a DB, an adapter, or a loaded config.
 */

/** What should happen to this message. */
export type DispatchDecision =
  | { readonly kind: 'chat'; readonly message: string; readonly notice?: string }
  | { readonly kind: 'workflow'; readonly workflowName: string; readonly message: string };

/**
 * Look up a project's default workflow in the `defaultWorkflows:` table.
 *
 * The table comes from YAML that is cast, not schema-validated, so both the
 * map and its values are checked defensively. Keys are matched exactly
 * first, then case-insensitively, so a capitalization typo in hand-written
 * YAML doesn't silently disable the feature for that project.
 */
function lookupDefaultWorkflow(
  defaultWorkflows: Record<string, string> | undefined,
  codebaseName: string | undefined
): string | undefined {
  if (!defaultWorkflows || typeof defaultWorkflows !== 'object' || !codebaseName) return undefined;

  const exact = defaultWorkflows[codebaseName];
  if (typeof exact === 'string' && exact.trim()) return exact.trim();

  const lowered = codebaseName.toLowerCase();
  for (const [project, workflowName] of Object.entries(defaultWorkflows)) {
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
 * Only applies inside a conversation whose project has a `defaultWorkflows:`
 * entry — everywhere else, the message passes through untouched. Within a
 * mapped project, in order:
 *
 *   1. A configured bypass prefix at the start of the message -> normal AI
 *      chat, with a notice naming what was bypassed.
 *   2. A slash-command pattern (`/word`) ANYWHERE in the message -> normal AI
 *      chat, with a notice. Not anchored to the start: "what do you know
 *      about /workflow list" bypasses just as much as a message that opens
 *      with the slash, since either way the user is talking ABOUT a command,
 *      not sending a plain instruction for the default workflow to act on.
 *   3. Otherwise -> the project's default workflow.
 *
 * @param message          Raw inbound message text.
 * @param codebaseName     Name of the project bound to the conversation, if any.
 * @param defaultWorkflows The global `defaultWorkflows:` table, if configured.
 * @param configuredBypass The global `defaultWorkflowBypass:`, if configured.
 *                         Blank or unset means the bypass-prefix rule never
 *                         matches — there is no built-in default.
 */
export function resolveDispatch(
  message: string,
  codebaseName: string | undefined,
  defaultWorkflows: Record<string, string> | undefined,
  configuredBypass?: string
): DispatchDecision {
  const workflowName = lookupDefaultWorkflow(defaultWorkflows, codebaseName);
  if (!workflowName) return { kind: 'chat', message };

  // Matched against the message with only its LEADING whitespace stripped,
  // never the fully trimmed form — a bypass prefix that ends in a separator
  // (e.g. '* ') can never prefix a string whose trailing whitespace was
  // already removed.
  const leading = message.replace(/^\s+/, '');

  // Leading whitespace on the CONFIGURED value is stripped too, so a stray
  // indent in YAML (' * ' vs '* ') doesn't change what counts as a match.
  // Trailing whitespace is kept — that's what makes '* ' require a separator.
  const bypass =
    typeof configuredBypass === 'string' && configuredBypass.trim()
      ? configuredBypass.replace(/^\s+/, '')
      : undefined;
  if (bypass && leading.startsWith(bypass)) {
    const stripped = leading.slice(bypass.length).trim();
    return {
      kind: 'chat',
      message: stripped || message,
      notice: `Bypass sigil '${bypass}' detected, bypassing default workflow: ${workflowName}`,
    };
  }

  if (/\/\w+/.test(message)) {
    return {
      kind: 'chat',
      message,
      notice: `Command (slash) detected, bypassing default workflow: ${workflowName}`,
    };
  }

  return { kind: 'workflow', workflowName, message };
}
