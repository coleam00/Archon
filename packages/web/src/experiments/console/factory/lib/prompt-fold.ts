/**
 * A long prompt is folded after its first screen (owner change 7 of 2026-11-21), with "Show the
 * whole prompt". Counted in source lines, which a reader can check against the command file:
 * about what the folded panel's height shows of a prompt with a few headings and lists.
 */
const PROMPT_FOLD_LINES = 30;

/** Whether `prompt` is long enough to fold. */
export function foldsPrompt(prompt: string): boolean {
  return prompt.trimEnd().split('\n').length > PROMPT_FOLD_LINES;
}
