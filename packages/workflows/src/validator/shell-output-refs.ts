import type { DagNode } from '../schemas';
import { PRIOR_OUTPUT_PATH_SOURCE, CURRENT_OUTPUT_PATH_SOURCE } from '../output-ref';
import { visitNodeTemplateSlots } from '../template-walker';
import type { ResourceValidation } from './context';

/**
 * Shell slots that wrap an output substitution in quotes, or leave it bare where it can
 * word-split. Archon already shell-quotes the value it substitutes.
 */
export function validateShellOutputRefs(validation: ResourceValidation, node: DagNode): void {
  visitNodeTemplateSlots(
    node,
    slot => {
      if (slot.surface !== 'shell') return;
      const { quoted, bare } = shellOutputRefWarnings(slot.value);
      if (bare) {
        validation.issues.push({
          level: 'warning',
          code: 'shell_output_ref',
          nodeId: node.id,
          field: slot.path,
          message:
            'A bare $nodeId.output / $LOOP_PREV.nodeId.output substitution can word-split and expand globs when a large output spills to a file',
          hint: 'Assign, then quote the variable: `var=$node.output.field; printf "%s" "$var"` (or `var=$LOOP_PREV.node.output.field`). The reference must be the whole assignment value.',
        });
      }
      if (!quoted) return;
      validation.issues.push({
        level: 'warning',
        code: 'shell_output_ref',
        nodeId: node.id,
        field: slot.path,
        message:
          '`"$nodeId.output"` / `\'$nodeId.output\'` / `"$LOOP_PREV.nodeId.output"` / `\'$LOOP_PREV.nodeId.output\'` — wrapping a substitution that is already shell-quoted by Archon produces the wrong value',
        hint: 'Assign, then quote the variable: `var=$node.output.field; printf "%s" "$var"` or `var=$LOOP_PREV.node.output.field; printf "%s" "$var"`. Numeric/boolean fields are injected raw, but the rule is uniform.',
      });
    },
    // Body nodes of a loop_group are validated on their own; recursing would double-report.
    { recursive: false }
  );
}

interface ShellOutputRefWarnings {
  quoted: boolean;
  bare: boolean;
}

interface Heredoc {
  delimiter: string;
  stripTabs: boolean;
}

/** Scanner state for one line, read and advanced one character at a time. */
interface LineScan {
  line: string;
  heredocs: Heredoc[];
  warnings: ShellOutputRefWarnings;
  quote: string | undefined;
  openedAtBoundary: boolean;
  wordStart: number;
  words: string[];
  escaped: boolean;
  commandSubstitutions: number;
  arithmetic: number;
}

const OUTPUT_REF = new RegExp(`${PRIOR_OUTPUT_PATH_SOURCE}|${CURRENT_OUTPUT_PATH_SOURCE}`, 'g');
const SHELL_NAME_ASSIGNMENT = /^[a-zA-Z_][a-zA-Z0-9_]*=/;
const HEREDOC_OPENER = /^<<(-?)[ \t]*(?:'([^']+)'|"([^"\n]+)"|\\?([a-zA-Z_][a-zA-Z0-9_]*))/;

// Shell slots share the executor's size-dependent substitution contract. This is a
// line-local lint, not a shell parser: preserve operand-boundary quote tracking and
// leave heredoc contents alone, including refs inside a quoted $(cat <<EOF) wrapper.
// `#` starts a comment only at a word start, and `<<` inside `((...))` is a shift.
function shellOutputRefWarnings(body: string): ShellOutputRefWarnings {
  const warnings = { quoted: false, bare: false };
  const heredocs: Heredoc[] = [];
  for (const line of body.split('\n')) {
    const heredoc = heredocs[0];
    if (heredoc === undefined) scanLine(line, heredocs, warnings);
    else if (closesHeredoc(line, heredoc)) heredocs.shift();
  }
  return warnings;
}

function closesHeredoc(line: string, heredoc: Heredoc): boolean {
  return (heredoc.stripTabs ? line.replace(/^\t+/, '') : line) === heredoc.delimiter;
}

function scanLine(line: string, heredocs: Heredoc[], warnings: ShellOutputRefWarnings): void {
  const refs = new Map(Array.from(line.matchAll(OUTPUT_REF), match => [match.index, match[0]]));
  const scan: LineScan = {
    line,
    heredocs,
    warnings,
    quote: undefined,
    openedAtBoundary: false,
    wordStart: 0,
    words: [],
    escaped: false,
    commandSubstitutions: 0,
    arithmetic: 0,
  };
  for (let index = 0; index < line.length; index += 1) {
    if (startsComment(scan, index)) break;
    trackWords(scan, index);
    trackNesting(scan, index);
    trackHeredocOpener(scan, index);
    const ref = refs.get(index);
    if (ref !== undefined) checkRef(scan, index, ref);
    trackQuote(scan, index);
    scan.escaped = !scan.escaped && line[index] === '\\' && scan.quote !== "'";
  }
}

function startsComment(scan: LineScan, index: number): boolean {
  const previous = scan.line[index - 1];
  const wordBoundary = previous === undefined || /[\s;&|(]/.test(previous);
  return !scan.escaped && scan.quote === undefined && scan.line[index] === '#' && wordBoundary;
}

/** Collect the words of the current simple command, so a ref can tell it is an assignment. */
function trackWords(scan: LineScan, index: number): void {
  if (scan.escaped || (scan.quote !== undefined && scan.openedAtBoundary)) return;
  const character = scan.line[index];
  if (/[;&|()]/.test(character)) {
    scan.words.length = 0;
    scan.wordStart = index + 1;
  } else if (/\s/.test(character)) {
    if (scan.wordStart < index) scan.words.push(scan.line.slice(scan.wordStart, index));
    scan.wordStart = index + 1;
  }
}

function trackNesting(scan: LineScan, index: number): void {
  if (scan.escaped || scan.quote === "'") return;
  const { line } = scan;
  const character = line[index];
  const previous = line[index - 1];
  const next = line[index + 1];
  if (character === '$' && next === '(') scan.commandSubstitutions += 1;
  else if (character === ')' && scan.commandSubstitutions > 0) scan.commandSubstitutions -= 1;
  if (character === '(' && next === '(' && previous !== '(') scan.arithmetic += 1;
  else if (character === ')' && next === ')' && previous !== ')' && scan.arithmetic > 0)
    scan.arithmetic -= 1;
}

function trackHeredocOpener(scan: LineScan, index: number): void {
  if (!opensHeredoc(scan, index)) return;
  const opener = HEREDOC_OPENER.exec(scan.line.slice(index));
  if (opener === null) return;
  scan.heredocs.push({
    delimiter: opener[2] ?? opener[3] ?? opener[4],
    stripTabs: opener[1] === '-',
  });
}

function opensHeredoc(scan: LineScan, index: number): boolean {
  const { line } = scan;
  const unquoted =
    scan.quote === undefined || (scan.quote === '"' && scan.commandSubstitutions > 0);
  return (
    !scan.escaped &&
    line[index] === '<' &&
    line[index + 1] === '<' &&
    line[index - 1] !== '<' &&
    scan.arithmetic === 0 &&
    unquoted
  );
}

function checkRef(scan: LineScan, index: number, ref: string): void {
  if (isWrappedInQuotes(scan)) scan.warnings.quoted = true;
  else if (!isWholeAssignmentValue(scan, index, ref)) scan.warnings.bare = true;
}

/** The ref sits inside quotes the author opened at an operand boundary: `"$n.output"`. */
function isWrappedInQuotes(scan: LineScan): boolean {
  return scan.quote !== undefined && scan.openedAtBoundary;
}

/** The ref is the entire value of a plain assignment, such as `var=$n.output`. */
function isWholeAssignmentValue(scan: LineScan, index: number, ref: string): boolean {
  const { line, words } = scan;
  const precedingAssignments =
    words[0] === 'export' || words[0] === 'local' ? words.slice(1) : words;
  const assignment =
    /^[a-zA-Z_][a-zA-Z0-9_]*=$/.test(line.slice(scan.wordStart, index)) &&
    precedingAssignments.every(word => SHELL_NAME_ASSIGNMENT.test(word));
  const next = line[index + ref.length];
  return assignment && (next === undefined || /[\s;&|)<>]/.test(next));
}

function trackQuote(scan: LineScan, index: number): void {
  if (scan.escaped) return;
  const character = scan.line[index];
  if (scan.quote === undefined) {
    if (character === '"' || character === "'") {
      const previous = scan.line[index - 1];
      scan.quote = character;
      scan.openedAtBoundary = previous === undefined || previous === '=' || /\s/.test(previous);
    }
  } else if (character === scan.quote) {
    scan.quote = undefined;
  }
}
