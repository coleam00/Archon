/**
 * Group commands for display by the ONE property a command actually declares:
 * `source` (`project` / `global` / `bundled`), which the engine sets when it
 * discovers the file.
 *
 * This replaces a set of display "categories" — Investigation, Planning, Code
 * Review, … — inferred by matching each command's filename against hardcoded
 * prefix lists. `CommandEntry` is `{ name, source }`; there is no category
 * concept anywhere in the engine, so that grouping asserted a classification
 * nothing had made, and any command matching no prefix landed silently in
 * "Utilities" — misrepresenting it in the node palette with no warning. The
 * precedent is `getWorkflowTags`, which uses a workflow's typed `tags` field
 * verbatim and only infers when the field is absent. Commands have no such
 * field, so there is nothing to fall back FROM: group by what is declared.
 */
import type { CommandEntry, WorkflowSource } from '@/lib/api';

export interface CommandGroup {
  /**
   * The declared source this group represents — stable identity for React keys,
   * collapse state, and default-open checks. Distinct from `label`, which is
   * display text: a caller keying off the label would tie behaviour to prose.
   */
  source: string;
  /** Display text for the group header. */
  label: string;
  commands: CommandEntry[];
}

/** Display order and label per source. Project first — it is the user's own. */
const SOURCE_GROUPS: readonly { source: WorkflowSource; label: string }[] = [
  { source: 'project', label: 'Project' },
  { source: 'global', label: 'Global' },
  { source: 'bundled', label: 'Bundled' },
];

/**
 * Group commands by source, in `SOURCE_GROUPS` order. Empty groups are omitted.
 * A command whose source is not one of the three (server/type drift) is placed
 * in a trailing group labelled with the raw value rather than being dropped.
 */
export function groupCommandsBySource(commands: CommandEntry[]): CommandGroup[] {
  const bySource = new Map<string, CommandEntry[]>();
  for (const command of commands) {
    const list = bySource.get(command.source);
    if (list) list.push(command);
    else bySource.set(command.source, [command]);
  }

  const groups: CommandGroup[] = [];
  for (const { source, label } of SOURCE_GROUPS) {
    const found = bySource.get(source);
    if (found && found.length > 0) groups.push({ source, label, commands: found });
    bySource.delete(source);
  }
  // Anything left is an unknown source — surface it rather than hide it. Its
  // raw value is the label, which is why identity lives in `source`: a drifted
  // value spelled "Project" must not merge with the known project group.
  for (const [source, found] of bySource) {
    if (found.length > 0) groups.push({ source, label: source, commands: found });
  }
  return groups;
}
