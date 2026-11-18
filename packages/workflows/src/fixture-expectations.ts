import type { DryRunResult } from './dry-run';
import type { FixtureDeclaration } from './fixture-runner';

/** Compares text the checkout may have converted to CRLF against a fixture's LF expectation. */
const withLfEndings = (text: string): string => text.replaceAll('\r\n', '\n');

export function fixtureResolvedTextFailure(
  result: DryRunResult,
  declaration: FixtureDeclaration
): string | undefined {
  if (declaration['resolved-text-contains'] === undefined) return undefined;
  for (const [nodeId, expectedText] of Object.entries(declaration['resolved-text-contains'])) {
    const traceEntries = result.trace.filter(
      entry =>
        entry.nodeId === nodeId &&
        (entry.state === 'completed' || entry.state === 'stubbed' || entry.state === 'paused')
    );
    if (traceEntries.length === 0) {
      return `expected resolved text for node '${nodeId}', but it was not reached`;
    }
    // Line endings belong to the checkout, not to the workflow. A command file is read as
    // raw text, so `* text=auto` gives a Windows clone CRLF inside it, while a fixture
    // spells its expectation with `\n` escapes that stay LF everywhere. This declaration is
    // about interpolated content, so it compares on LF alone rather than passing on Linux
    // and failing on Windows for the same workflow. (Workflow YAML is immune: the parser
    // normalizes line breaks in its own scalars.)
    const expected = withLfEndings(expectedText);
    if (
      !traceEntries.some(
        entry =>
          entry.resolvedText !== undefined && withLfEndings(entry.resolvedText).includes(expected)
      )
    ) {
      return `expected node '${nodeId}' resolved text to contain ${JSON.stringify(expectedText)}`;
    }
  }
  return undefined;
}

export function fixtureWaitLabelsFailure(
  result: DryRunResult,
  declaration: FixtureDeclaration
): string | undefined {
  if (declaration['wait-labels'] === undefined) return undefined;
  for (const [nodeId, expectedLabels] of Object.entries(declaration['wait-labels'])) {
    const entries = result.trace.filter(
      entry => entry.nodeId === nodeId && entry.attentionAsk !== undefined
    );
    if (entries.length === 0) return `expected labels for wait '${nodeId}', but it was not reached`;
    if (!entries.every(entry => Bun.deepEquals(entry.attentionAsk?.labels ?? {}, expectedLabels))) {
      return `expected wait '${nodeId}' labels to equal ${JSON.stringify(expectedLabels)}`;
    }
  }
  return undefined;
}
