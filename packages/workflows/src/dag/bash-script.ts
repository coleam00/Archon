export function bashScriptCommand(script: string): { args: string[]; input: string } {
  if (script.includes('\0')) throw new Error('Bash source cannot contain NUL bytes');
  // Read the whole source before evaluation so authored reads cannot consume source lines.
  return {
    args: [
      '-c',
      'IFS= read -r -d "" __archon_bash_source || :; eval -- "unset __archon_bash_source; $__archon_bash_source"',
    ],
    input: script,
  };
}
