/**
 * GitHub Copilot CLI community provider — argv builder.
 *
 * Translates Archon provider config + node config + request options
 * into a safe argv array for `spawn(binary, args, ...)`.
 * Never uses shell string concatenation.
 */
import type { CopilotProviderDefaults, NodeConfig } from '../../types';

export interface BuildCopilotArgsOptions {
  prompt: string;
  /** requestOptions.model overrides assistantConfig model */
  modelOverride?: string;
  config: CopilotProviderDefaults;
  nodeConfig?: NodeConfig;
}

/**
 * Build the argv array for the Copilot CLI invocation.
 *
 * Arg mapping:
 *   prompt          → -p <prompt>
 *   model           → --model=<model>
 *   noAskUser       → --no-ask-user  (default true if not explicitly false)
 *   allowTools[]    → repeated --allow-tool=<tool>
 *   denyTools[]     → repeated --deny-tool=<tool>
 *   nodeConfig.allowed_tools → additional --allow-tool=<tool>
 *   nodeConfig.denied_tools  → additional --deny-tool=<tool>
 *   allowAllTools   → --allow-all-tools  (+ security warning emitted by provider)
 *   allowAll        → --allow-all        (+ security warning emitted by provider)
 *   allowAllPaths   → --allow-all-paths
 *   addDirs[]       → repeated --add-dir=<dir>
 *   allowUrls[]     → repeated --allow-url=<url>
 *   denyUrls[]      → repeated --deny-url=<url>
 *   allowAllUrls    → --allow-all-urls
 *   secretEnvVars[] → --secret-env-vars=VAR1,VAR2,...
 *   extraArgs[]     → appended verbatim (for flags like --available-tools=write_powershell)
 */
export function buildCopilotArgs(opts: BuildCopilotArgsOptions): string[] {
  const { prompt, modelOverride, config, nodeConfig } = opts;
  const args: string[] = [];

  // Prompt — required
  args.push('-p', prompt);

  // Model (requestOptions.model overrides assistantConfig model)
  const resolvedModel = modelOverride ?? config.model;
  if (resolvedModel) {
    args.push(`--model=${resolvedModel}`);
  }

  // --no-ask-user: default true for non-interactive safety
  // Explicitly disabled only when config.noAskUser === false
  if (config.noAskUser !== false) {
    args.push('--no-ask-user');
  }

  // allowAllTools — security: warn from provider, but wire the flag
  if (config.allowAllTools) {
    args.push('--allow-all-tools');
  }

  // allowAll — security: warn from provider, but wire the flag
  if (config.allowAll) {
    args.push('--allow-all');
  }

  // allowAllPaths
  if (config.allowAllPaths) {
    args.push('--allow-all-paths');
  }

  // allowAllUrls
  if (config.allowAllUrls) {
    args.push('--allow-all-urls');
  }

  // Allow tools: config level + node level (deduplicated)
  const allowToolSet = new Set<string>();
  for (const tool of config.allowTools ?? []) {
    allowToolSet.add(tool);
  }
  for (const tool of nodeConfig?.allowed_tools ?? []) {
    allowToolSet.add(tool);
  }

  // Deny tools: config level + node level (deduplicated)
  const denyToolSet = new Set<string>();
  for (const tool of config.denyTools ?? []) {
    denyToolSet.add(tool);
  }
  for (const tool of nodeConfig?.denied_tools ?? []) {
    denyToolSet.add(tool);
  }

  // Deterministic conflict resolution: deny wins over allow.
  for (const deniedTool of denyToolSet) {
    allowToolSet.delete(deniedTool);
  }

  for (const tool of allowToolSet) {
    args.push(`--allow-tool=${tool}`);
  }

  for (const tool of denyToolSet) {
    args.push(`--deny-tool=${tool}`);
  }

  // addDirs
  for (const dir of config.addDirs ?? []) {
    args.push(`--add-dir=${dir}`);
  }

  // allowUrls
  for (const url of config.allowUrls ?? []) {
    args.push(`--allow-url=${url}`);
  }

  // denyUrls
  for (const url of config.denyUrls ?? []) {
    args.push(`--deny-url=${url}`);
  }

  // secretEnvVars — joined into a single comma-separated flag
  if (config.secretEnvVars && config.secretEnvVars.length > 0) {
    args.push(`--secret-env-vars=${config.secretEnvVars.join(',')}`);
  }

  // extraArgs: appended verbatim (experimental flags, e.g. --available-tools=write_powershell)
  for (const extra of config.extraArgs ?? []) {
    args.push(extra);
  }

  return args;
}
