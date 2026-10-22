/** The shapes of the help tables `help.ts` renders. */

export interface FlagOwner {
  command: string;
  subcommand?: string;
}

export interface FlagHelp {
  spec: string;
  description: string;
  // Each (command, subcommand?) tuple that owns this flag. Scoped-only flags
  // omit owners because their enclosing entry owns them; empty means "global".
  owners?: FlagOwner[];
}

export interface ExampleHelp {
  text: string;
  // The (command, subcommand?) tuple this example belongs to. An example
  // appears in `archon --help` iff its owner is selected.
  owner: FlagOwner;
}

export interface HelpEntry {
  command: string;
  subcommand?: string;
  spec: string;
  // Use `\n` to force a continuation line; each continuation aligns to
  // column 29. The renderer wraps to the next line when the spec itself
  // overflows the description column (spec.length > 35).
  description: string;
  // Flags shown only in the matching command or subcommand Options block.
  scopedFlags?: FlagHelp[];
}

/** One command group's rows: those the global index lists, and those only its scoped help shows. */
export interface HelpGroup {
  entries: HelpEntry[];
  scopedOnly?: HelpEntry[];
}
