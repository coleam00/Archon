/** Engine-private included-loop compilation metadata. Symbols survive object spreads
 * but stay out of YAML, JSON, API payloads, and persisted workflow definitions. */
export const COMPILED_LOOP_COMMAND = Symbol('archon.compiled-loop-command');

export type CompiledLoopCommand =
  | { prompt: string; error?: never }
  | { prompt?: never; error: string };

export interface LoopWithCompiledCommand {
  [COMPILED_LOOP_COMMAND]?: CompiledLoopCommand;
}
