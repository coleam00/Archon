import type { DiagnosticTextFormatter } from './diagnostic-text';
import {
  collectCredentialValues,
  redactCredentialValues,
} from '@archon/paths/credential-redaction';
import type { WorkflowConfig } from './deps';
import type { DryRunTraceEntry } from './dry-run';
import { shellQuote } from './dag/shell-quote';

export function fixtureTraceRedactor(config: WorkflowConfig | undefined) {
  const credentials = new Set(
    collectCredentialValues(
      { ...process.env, ...config?.envVars },
      config?.protectedEnvKeys,
      config?.protectedCredentialValues
    )
  );
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
  const diagnostics = new Map<string, () => string>();
  const formatDiagnostic: DiagnosticTextFormatter = render => {
    const original = render(text => text);
    diagnostics.set(original, () => render(redact));
    return original;
  };
  const redactPublished = (text: string): string => {
    for (const [original, protectedText] of diagnostics) {
      text = text.replaceAll(original, () => protectedText());
    }
    return redact(text);
  };
  const redactTrace = (trace: readonly DryRunTraceEntry[]): DryRunTraceEntry[] =>
    trace.map(entry => ({
      ...entry,
      ...(entry.resolvedText !== undefined
        ? { resolvedText: redactPublished(entry.resolvedText) }
        : {}),
      ...(entry.output !== undefined ? { output: redactPublished(entry.output) } : {}),
      ...(entry.reason !== undefined ? { reason: redactPublished(entry.reason) } : {}),
    }));
  return {
    formatDiagnostic,
    collect: (values: readonly string[]): void => {
      for (const value of values) credentials.add(value);
    },
    publish: (rawTrace: readonly DryRunTraceEntry[], failureReason: string | undefined) => {
      const trace = failureReason === undefined ? rawTrace : redactTrace(rawTrace);
      return {
        nodeFailures: trace
          .filter(entry => entry.state === 'failed')
          .map(({ nodeId, reason }) => ({ nodeId, reason })),
        ...(failureReason !== undefined
          ? { failureReason: redactPublished(failureReason), trace }
          : {}),
      };
    },
  };
}
