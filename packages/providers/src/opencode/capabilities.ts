export const OPENCODE_CAPABILITIES = {
  sessionResume: true,
  mcp: true,
  hooks: false, // OpenCode doesn't support SDK-style hooks yet
  skills: true,
  agents: true,
  toolRestrictions: true,
  structuredOutput: true,
  envInjection: true,
  costControl: false,
  effortControl: false,
  thinkingControl: true,
  fallbackModel: false,
  sandbox: false,
};
