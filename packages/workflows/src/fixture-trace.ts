import {
  collectCredentialValues,
  redactCredentialValues,
} from '@archon/paths/credential-redaction';
import type { WorkflowConfig } from './deps';
import type { DryRunTraceEntry } from './dry-run';
import { shellQuote } from './dag/shell-quote';

export function fixtureTraceRedactor(
  config: WorkflowConfig | undefined,
  inputs?: Record<string, string>
) {
  const credentials = new Set([
    ...collectCredentialValues(
      { ...process.env, ...config?.envVars },
      config?.protectedEnvKeys,
      config?.protectedCredentialValues
    ),
    ...collectCredentialValues(inputs ?? {}),
  ]);
  const redact = (text: string): string => {
    // Canonical JSON can be shell-interpolated, then JSON-quoted again in diagnostics.
    const jsonInterior = (value: string): string => JSON.stringify(value).slice(1, -1);
    const representations = [...credentials]
      .flatMap(value => [value, jsonInterior(value)])
      .flatMap(value => [value, shellQuote(value).slice(1, -1)])
      .flatMap(value => [value, jsonInterior(value)]);
    return redactCredentialValues(
      text,
      representations.sort((a, b) => b.length - a.length)
    );
  };
  const redactTrace = (trace: readonly DryRunTraceEntry[]): DryRunTraceEntry[] =>
    trace.map(entry => ({
      ...entry,
      ...(entry.resolvedText !== undefined ? { resolvedText: redact(entry.resolvedText) } : {}),
      ...(entry.output !== undefined ? { output: redact(entry.output) } : {}),
      ...(entry.reason !== undefined ? { reason: redact(entry.reason) } : {}),
    }));
  return {
    collect: (values: readonly string[]): void => {
      for (const value of values) credentials.add(value);
    },
    publish: (rawTrace: readonly DryRunTraceEntry[], failureReason: string | undefined) => {
      const trace = failureReason === undefined ? rawTrace : redactTrace(rawTrace);
      return {
        nodeFailures: trace
          .filter(entry => entry.state === 'failed')
          .map(({ nodeId, reason }) => ({ nodeId, reason })),
        ...(failureReason !== undefined ? { failureReason: redact(failureReason), trace } : {}),
      };
    },
  };
}
