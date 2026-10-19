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

// Shell slots share the executor's size-dependent substitution contract. This is a
// line-local lint, not a shell parser: preserve operand-boundary quote tracking and
// leave heredoc contents alone, including refs inside a quoted $(cat <<EOF) wrapper.
// `#` starts a comment only at a word start, and `<<` inside `((...))` is a shift.
function shellOutputRefWarnings(body: string): { quoted: boolean; bare: boolean } {
  let quoted = false;
  let bare = false;
  const heredocs: { delimiter: string; stripTabs: boolean }[] = [];
  const refFinder = new RegExp(`${PRIOR_OUTPUT_PATH_SOURCE}|${CURRENT_OUTPUT_PATH_SOURCE}`, 'g');
  for (const line of body.split('\n')) {
    const heredoc = heredocs[0];
    if (heredoc !== undefined) {
      if ((heredoc.stripTabs ? line.replace(/^\t+/, '') : line) === heredoc.delimiter)
        heredocs.shift();
      continue;
    }
    const refs = new Map(Array.from(line.matchAll(refFinder), match => [match.index, match[0]]));
    let quote: string | undefined;
    let openedAtBoundary = false;
    let wordStart = 0;
    const words: string[] = [];
    let escaped = false;
    let commandSubstitutions = 0;
    let arithmetic = 0;
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      const previous = line[index - 1];
      const operandBoundary = previous === undefined || previous === '=' || /\s/.test(previous);
      const wordBoundary = previous === undefined || /[\s;&|(]/.test(previous);
      if (!escaped && quote === undefined && character === '#' && wordBoundary) break;
      if (!escaped && (quote === undefined || !openedAtBoundary)) {
        if (/[;&|()]/.test(character)) {
          words.length = 0;
          wordStart = index + 1;
        } else if (/\s/.test(character)) {
          if (wordStart < index) words.push(line.slice(wordStart, index));
          wordStart = index + 1;
        }
      }
      if (!escaped && quote !== "'") {
        if (character === '$' && line[index + 1] === '(') commandSubstitutions += 1;
        else if (character === ')' && commandSubstitutions > 0) commandSubstitutions -= 1;
        if (character === '(' && line[index + 1] === '(' && previous !== '(') arithmetic += 1;
        else if (character === ')' && line[index + 1] === ')' && previous !== ')' && arithmetic > 0)
          arithmetic -= 1;
      }
      if (
        !escaped &&
        character === '<' &&
        line[index + 1] === '<' &&
        line[index - 1] !== '<' &&
        arithmetic === 0 &&
        (quote === undefined || (quote === '"' && commandSubstitutions > 0))
      ) {
        const opener = /^<<(-?)[ \t]*(?:'([^']+)'|"([^"\n]+)"|\\?([a-zA-Z_][a-zA-Z0-9_]*))/.exec(
          line.slice(index)
        );
        if (opener !== null) {
          heredocs.push({
            delimiter: opener[2] ?? opener[3] ?? opener[4],
            stripTabs: opener[1] === '-',
          });
        }
      }
      const ref = refs.get(index);
      if (ref !== undefined) {
        if (quote !== undefined && openedAtBoundary) quoted = true;
        else {
          const precedingAssignments =
            words[0] === 'export' || words[0] === 'local' ? words.slice(1) : words;
          const assignment =
            /^[a-zA-Z_][a-zA-Z0-9_]*=$/.test(line.slice(wordStart, index)) &&
            precedingAssignments.every(word => /^[a-zA-Z_][a-zA-Z0-9_]*=/.test(word));
          const next = line[index + ref.length];
          if (!assignment || (next !== undefined && !/[\s;&|)<>]/.test(next))) bare = true;
        }
      }
      if (!escaped && quote === undefined) {
        if (character === '"' || character === "'") {
          quote = character;
          openedAtBoundary = operandBoundary;
        }
      } else if (!escaped && character === quote) {
        quote = undefined;
      }
      escaped = !escaped && character === '\\' && quote !== "'";
    }
  }
  return { quoted, bare };
}
