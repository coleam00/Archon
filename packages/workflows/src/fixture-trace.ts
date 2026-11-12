import {
  collectCredentialValues,
  redactCredentialValues,
} from '@archon/paths/credential-redaction';
import type { WorkflowConfig } from './deps';
import type { DryRunTraceEntry } from './dry-run';

export function redactFixtureTrace(
  trace: readonly DryRunTraceEntry[],
  config: WorkflowConfig | undefined
): DryRunTraceEntry[] {
  const credentialValues = collectCredentialValues(
    { ...process.env, ...config?.envVars },
    config?.protectedEnvKeys,
    config?.protectedCredentialValues
  );
  return trace.map(entry => ({
    ...entry,
    ...(entry.resolvedText !== undefined
      ? { resolvedText: redactCredentialValues(entry.resolvedText, credentialValues) }
      : {}),
    ...(entry.output !== undefined
      ? { output: redactCredentialValues(entry.output, credentialValues) }
      : {}),
  }));
}
