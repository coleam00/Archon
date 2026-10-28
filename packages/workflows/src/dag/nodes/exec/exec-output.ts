import { finishNodeExecution } from '../../../node-execution';
import { type NodeExecutionResult } from '../../../node-record-serialization';
import { type NodeExecutionRecord } from '../../../schemas/node-execution';
import { recordNodeState } from '../../../node-event-write';
import { redactCredentialValues } from '@archon/paths/credential-redaction';
import { validateStructuredOutput } from '../../../structured-output';
import type { ExecNode, SkipCause, WorkflowRun } from '../../../schemas';
import {
  declaredOutputPathsFromSchema,
  type DeclaredOutputPaths,
  canonicalValueText,
  type JsonValue,
} from '../../../output-ref';
import { getLog } from '../../log';
import { type RunLayersContext } from '../../run-context';
import { rejectedArtifactPointer } from '../../node-output';

/**
 * A deterministic producer's stdout did not satisfy the contract it declared.
 *
 * Its own class so the exec catch blocks report Archon's diagnosis verbatim instead of
 * running it through `formatSubprocessFailure` — which would re-label it as a subprocess
 * diagnostic and, worse, read a stdout excerpt containing "timed out" as a timeout.
 */
export class ExecOutputContractError extends Error {}

/** How much of the offending stdout a contract failure quotes back to the author. */
const EXEC_CONTRACT_STDOUT_PREVIEW = 200;

function execStdoutPreview(stdout: string, credentialValues: readonly string[]): string {
  // Redact BEFORE slicing: the preview lands in `node_failed.data.error`, and a credential
  // that straddles the cut would otherwise leak its head. Retention (#2967) already applies
  // the same set to the tails; the quoted excerpt must not be the one unredacted copy.
  const redacted = redactCredentialValues(stdout, credentialValues);
  const head = redacted.slice(0, EXEC_CONTRACT_STDOUT_PREVIEW);
  return `${JSON.stringify(head)}${redacted.length > head.length ? ' …[truncated]' : ''}`;
}

/**
 * Certify a `bash:`/`script:` node's stdout against the schema it declared (#2453).
 *
 * A deterministic producer that declares `output_format` owns a result contract exactly
 * like an AI producer does: its stdout must parse as ONE strict JSON document, satisfy the
 * shared ajv gate, and become the same logical-value + canonical-text + declared-fields
 * triple `executeAgentNode` returns. There is no fence stripping, no `jsonrepair` tier and
 * no reask — those exist because a model improvises; stdout that does not match the script's
 * own declaration is a bug in the script, and retrying it would only cost time.
 *
 * A node with no `output_format` returns its stdout byte-for-byte, as it always has.
 *
 * @throws ExecOutputContractError when stdout is not JSON, or fails the declared schema.
 */
export function certifyExecOutput(
  node: ExecNode,
  stdout: string,
  credentialValues: readonly string[]
): {
  output: string;
  structuredOutput?: JsonValue;
  declaredOutputPaths?: DeclaredOutputPaths;
} {
  if (node.output_format === undefined) return { output: stdout };

  const label = `${node.runtime === 'sh' ? 'Bash' : 'Script'} node '${node.id}'`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch (parseErr) {
    const diagnostic = redactCredentialValues((parseErr as Error).message, credentialValues);
    throw new ExecOutputContractError(
      `${label} declares an output_format, so its stdout must be a single JSON document, but it did not parse: ${diagnostic}. stdout began: ${execStdoutPreview(stdout, credentialValues)}`
    );
  }
  // `JSON.parse` can only yield a JsonValue — no undefined, no non-finite number, no
  // exotic prototype — so the value satisfies the logical domain by construction.
  const value = parsed as JsonValue;

  let schemaCompileError: string | undefined;
  const validation = validateStructuredOutput(value, node.output_format, compileMsg => {
    schemaCompileError = compileMsg;
  });
  if (schemaCompileError !== undefined) {
    // Same posture as the AI gate: the loader compiles every declared schema, so reaching
    // this branch means a definition bypassed it and the contract cannot be enforced.
    throw new ExecOutputContractError(
      `${label}: its output_format schema cannot be compiled (${schemaCompileError}), so its declared contract cannot be enforced. Fix the schema.`
    );
  }
  if (!validation.valid) {
    // AJV instance paths encode object keys as JSON Pointer segments.
    const diagnosticCredentialValues = credentialValues
      .flatMap(value => [value, value.replaceAll('~', '~0').replaceAll('/', '~1')])
      .sort((a, b) => b.length - a.length);
    const schemaErrors = redactCredentialValues(
      validation.errors.join('; '),
      diagnosticCredentialValues
    );
    throw new ExecOutputContractError(
      `${label}: stdout did not satisfy its declared output_format: ${schemaErrors}. stdout began: ${execStdoutPreview(stdout, credentialValues)}`
    );
  }

  // Same projection an AI producer captures: it lets a downstream `.field` ref tell a
  // declared-but-absent optional field ('') from a typo (throws).
  const declaredOutputPaths = declaredOutputPathsFromSchema(node.output_format);
  return {
    output: canonicalValueText(value),
    structuredOutput: value,
    ...(declaredOutputPaths !== undefined ? { declaredOutputPaths } : {}),
  };
}

/**
 * Artifact-pointer gate for a certified exec value (#2453).
 *
 * Raised as an {@link ExecOutputContractError} for the same reason a parse or schema
 * failure is: both exec catches inspect the message to tell Archon's own diagnosis from a
 * subprocess diagnostic, and a rejected pointer is a statement about the script's declared
 * result, not about how the subprocess exited.
 *
 * @throws ExecOutputContractError when the stdout value names an artifact it cannot address.
 */
export async function assertExecArtifactPointers(
  workflowRun: WorkflowRun,
  node: ExecNode,
  value: JsonValue | undefined
): Promise<void> {
  if (value === undefined) return;
  const badPointer = await rejectedArtifactPointer(workflowRun, value);
  if (badPointer === null) return;
  const label = `${node.runtime === 'sh' ? 'Bash' : 'Script'} node '${node.id}'`;
  throw new ExecOutputContractError(`${label}: ${badPointer}.`);
}

export async function recordExecTimeoutSkip(
  ctx: RunLayersContext,
  execution: NodeExecutionRecord
): Promise<NodeExecutionResult> {
  const cause: SkipCause = { kind: 'timeout' };
  getLog().info({ nodeId: execution.node.id }, 'dag_node_skipped_timeout');
  return recordNodeState(
    { store: ctx.deps.store, logDir: ctx.logDir },
    finishNodeExecution(execution, { status: 'skipped', reason: 'timeout', cause })
  );
}
