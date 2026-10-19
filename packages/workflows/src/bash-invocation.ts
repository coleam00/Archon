// Keep -c identity ($0/BASH_SOURCE) while avoiding OS argument-size limits.
// The subshell keeps the loader variable out of the authored script's scope.
const EVALUATOR = `eval "$(IFS= read -r -d '' __archon_bash_body || :; printf '%s' "$__archon_bash_body")"`;

export function bashInvocation(script: string): { args: string[]; input: string } {
  return { args: ['-c', EVALUATOR], input: script };
}
