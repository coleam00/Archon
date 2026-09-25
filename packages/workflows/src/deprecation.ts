import type { WorkflowDefinition } from './schemas/workflow';

/**
 * Composes the standard run-start deprecation notice (#2781) from a workflow's
 * declared `deprecated:` marker. The single formatting site — the chat/web
 * sender, the durable executor event, and the CLI stderr emitter all print
 * exactly this string.
 *
 * The wording is the maintainer's directive for #2781, verbatim in structure:
 * announce removal in an upcoming release, name both exits (the replacement
 * pack — carried by the declared message — and keeping a copy under project or
 * global `.archon/workflows/`, which wins discovery by filename).
 */
export function formatDeprecationNotice(
  workflow: Pick<WorkflowDefinition, 'name' | 'deprecated'>
): string | undefined {
  if (!workflow.deprecated) return undefined;
  return (
    `⚠️ \`${workflow.name}\` is deprecated and will be removed in an upcoming release. ` +
    `${workflow.deprecated.message} ` +
    'To keep using this workflow after removal, copy the workflow file into your project ' +
    '`.archon/workflows/` or your global `~/.archon/workflows/`.'
  );
}
