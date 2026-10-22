/**
 * Help tables preserve an explicit display order. Commands, flags and examples
 * carry owners so renderHelp can select the matching scoped slice.
 * An empty flag owners array means global help only; scoped-only flags belong
 * to their enclosing command entry.
 *
 * Each command group's rows live in its own help-table/ module. The global index
 * lists the groups' entries in `HELP_GROUPS` order, so each group must stay one
 * contiguous run of the index. Options and examples have their own global order,
 * which interleaves groups, so each is one list (help-table/options.ts, examples.ts).
 */

import { orderedExamples } from './help-table/examples';
import { forgeHelp } from './help-table/forge';
import { installHelp } from './help-table/install';
import { metaHelp } from './help-table/meta';
import { operatorHelp } from './help-table/operator';
import { orderedFlags } from './help-table/options';
import { stateHelp } from './help-table/state';
import type { ExampleHelp, FlagHelp, FlagOwner, HelpEntry, HelpGroup } from './help-table/types';
import { workflowHelp } from './help-table/workflow';
import { worktreeHelp } from './help-table/worktree';

const HELP_GROUPS: readonly HelpGroup[] = [
  stateHelp,
  forgeHelp,
  operatorHelp,
  workflowHelp,
  worktreeHelp,
  installHelp,
  metaHelp,
];

const commandHelp: HelpEntry[] = HELP_GROUPS.flatMap(group => group.entries);

// Every command entry in display order: the global entries, then the scoped-only ones.
export const helpEntries: readonly HelpEntry[] = [
  ...commandHelp,
  ...HELP_GROUPS.flatMap(group => group.scopedOnly ?? []),
];

// Description column in the Commands/Options block. Each line aligns its
// description to this column. Existing entries sit at spec.length <= 35
// (one space separator when padding has no room) or wrap to the next line
// when the spec itself overflows.
const HELP_DESC_COLUMN = 29;
const HELP_SPEC_WRAP_THRESHOLD = 35;

export function formatSpecLine(spec: string, description: string): string {
  const parts = description.split('\n');
  const first = parts[0] ?? '';
  const rest = parts.slice(1);
  let firstLine: string;
  if (spec.length > HELP_SPEC_WRAP_THRESHOLD) {
    // Spec overflows the column: description goes on its own line at col 29.
    firstLine = `  ${spec}\n${' '.repeat(HELP_DESC_COLUMN)}${first}`;
  } else if (spec.length + 2 <= HELP_DESC_COLUMN) {
    // Pad spec so description lands at col 29.
    const pad = ' '.repeat(HELP_DESC_COLUMN - spec.length - 2);
    firstLine = `  ${spec}${pad}${first}`;
  } else {
    // Spec fills 28–35 chars: one space separator.
    firstLine = `  ${spec} ${first}`;
  }
  const continuations = rest.map(part => ' '.repeat(HELP_DESC_COLUMN) + part).join('\n');
  return continuations ? `${firstLine}\n${continuations}` : firstLine;
}

function ownerKey(owner: FlagOwner): string {
  return `${owner.command}|${owner.subcommand ?? ''}`;
}

function selectFlagsFor(selected: HelpEntry[], scopedOnly: FlagHelp[] = []): FlagHelp[] {
  const keys = new Set(selected.map(e => ownerKey(e)));
  const seen = new Set<string>();
  const out: FlagHelp[] = [];
  // Scoped-only flags come first so they appear at the top of the scoped
  // Options block; the matching entry's Commands alias already mentions them.
  for (const f of scopedOnly) {
    if (seen.has(f.spec)) continue;
    seen.add(f.spec);
    out.push(f);
  }
  for (const f of orderedFlags) {
    if (!f.owners?.some(o => keys.has(ownerKey(o)))) continue;
    if (seen.has(f.spec)) continue;
    seen.add(f.spec);
    out.push(f);
  }
  return out;
}

function selectExamplesFor(selected: HelpEntry[]): ExampleHelp[] {
  const keys = new Set(selected.map(e => ownerKey(e)));
  return orderedExamples.filter(ex => keys.has(ownerKey(ex.owner)));
}

function selectEntries(command: string | undefined, subcommand: string | undefined): HelpEntry[] {
  if (command === undefined) return commandHelp;
  return helpEntries.filter(
    e => e.command === command && (subcommand === undefined || e.subcommand === subcommand)
  );
}

/**
 * Render help for CLI positionals. A multi-word subcommand such as
 * `attention label` spans its words; otherwise the second positional is it.
 */
export function renderHelpFor(positionals: readonly string[]): string {
  const [command, ...rest] = positionals;
  const words = `${rest.join(' ')} `;
  const spanned = helpEntries.find(
    e =>
      e.command === command && e.subcommand?.includes(' ') && words.startsWith(`${e.subcommand} `)
  );
  return renderHelp(command, spanned?.subcommand ?? rest[0]);
}

/**
 * Render the help slice for `command`/`subcommand`. With no arguments the
 * output is the global index. With a (command, subcommand) tuple, only that
 * slice is shown.
 */
export function renderHelp(command?: string, subcommand?: string): string {
  const entries = selectEntries(command, subcommand);
  const sections: string[] = [];
  sections.push('Archon CLI - Run AI workflows from the command line');
  sections.push('');
  sections.push('Usage:');
  sections.push('  archon <command> [subcommand] [options] [arguments]');
  sections.push('');
  sections.push('Commands:');
  sections.push(entries.map(e => formatSpecLine(e.spec, e.description)).join('\n'));
  const flags =
    command === undefined
      ? orderedFlags
      : selectFlagsFor(
          entries,
          entries.flatMap(e => e.scopedFlags ?? [])
        );
  if (flags.length > 0) {
    sections.push('');
    sections.push('Options:');
    sections.push(flags.map(f => formatSpecLine(f.spec, f.description)).join('\n'));
  }
  const examples = command === undefined ? orderedExamples : selectExamplesFor(entries);
  if (examples.length > 0) {
    sections.push('');
    sections.push('Examples:');
    sections.push(examples.map(ex => `  ${ex.text}`).join('\n'));
  }
  return `\n${sections.join('\n')}\n`;
}
