// Keep -c identity ($0/BASH_SOURCE) while avoiding OS argument-size limits.
// The subshell keeps the loader variable out of the authored script's scope.
// Quoting the buffered source preserves trailing newlines through command substitution.
const EVALUATOR = `eval "$(IFS= read -r -d '' __archon_bash_body || :; printf 'eval -- %q' "$__archon_bash_body")"`;

export function bashInvocation(script: string): { args: string[]; input: string } {
  if (script.includes('\0')) throw new Error('Bash source cannot contain NUL bytes');
  return { args: ['-c', EVALUATOR], input: script };
}
