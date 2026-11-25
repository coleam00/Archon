/**
 * Resolution of typed-outputs bindings: `with: { <name>: { outputs: <output_type> } }` on a
 * script node becomes the JSON array of every certified output of that type the run has
 * produced, in production order.
 *
 * A record that cannot be read fails the binding and names the record. An unreadable
 * sidecar has no trustworthy type, so it might be one of the outputs asked for; dropping
 * it would hand the script a shorter list that looks complete. A binding that declares
 * `if_unreadable` takes that value instead, and the failure is logged.
 */
import { join } from 'node:path';
import { createLogger } from '@archon/paths';
import { readArtifactFile } from './artifact-writes';
import { readNodeArtifacts } from './artifacts-index';
import type { JsonValue } from './output-ref';
import type { NodeArtifact } from './schemas/node-artifact';
import {
  isTypedOutputsDirective,
  type BindingDirective,
  type TypedOutputRecord,
  type TypedOutputsDirective,
} from './schemas/node-bindings';

/** Lazy logger (deferred so test mocks can intercept createLogger). */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('typed-output-bindings');
  return cachedLog;
}

/** The run holds a typed-output record the engine could not read. */
export class TypedOutputsUnreadableError extends Error {}

/** A typed output as the engine recorded it: who produced it, when, and its text. */
export interface RecordedTypedOutput
  extends Pick<NodeArtifact, 'nodeId' | 'outputType' | 'loopGroupPath' | 'producedAt'> {
  /** What a failure names: the content path in a real run, the node in a simulation. */
  source: string;
  text: string;
}

/** Every typed output of one type the run has recorded so far, in production order. */
export type TypedOutputsReader = (outputType: string) => Promise<RecordedTypedOutput[]>;

/**
 * The run's own recorded outputs, read from its artifact directory: the same records
 * `$TYPED_ARTIFACTS_FILE` lists. One directory read serves every binding of a node.
 */
export function runTypedOutputs(artifactsDir: string, runId: string): TypedOutputsReader {
  let read: ReturnType<typeof readNodeArtifacts> | undefined;
  return async outputType => {
    read ??= readNodeArtifacts(artifactsDir, { scope: 'current-run', runId });
    const { artifactsByType, errors } = await read;
    if (errors.length > 0) {
      const named = errors.map(
        error => `${error.path} (${error.kind}${error.code === undefined ? '' : `, ${error.code}`})`
      );
      throw new TypedOutputsUnreadableError(
        `the run has typed-output records that cannot be read: ${named.join('; ')}`
      );
    }
    const recorded: RecordedTypedOutput[] = [];
    // `Object.hasOwn`: an output type is an open string and must not resolve an inherited key.
    for (const artifact of Object.hasOwn(artifactsByType, outputType)
      ? artifactsByType[outputType]
      : []) {
      const text = await readArtifactFile(join(artifactsDir, artifact.path));
      if (text === undefined) {
        throw new TypedOutputsUnreadableError(`${artifact.path} cannot be read`);
      }
      recorded.push({ ...artifact, source: artifact.path, text });
    }
    return recorded;
  };
}

function typedOutputRecord(recorded: RecordedTypedOutput): TypedOutputRecord {
  let value: JsonValue;
  try {
    value = JSON.parse(recorded.text) as JsonValue;
  } catch {
    throw new Error(
      `${recorded.source}, the '${recorded.outputType}' output of node '${recorded.nodeId}', is not a JSON document; ` +
        `declare output_format on '${recorded.nodeId}' so its output is a certified value`
    );
  }
  return {
    node: recorded.nodeId,
    loop: (recorded.loopGroupPath ?? []).map(frame => ({
      group: frame.groupId,
      iteration: frame.iteration,
    })),
    at: recorded.producedAt,
    value,
  };
}

/**
 * A script node's `with:` map with each typed-outputs directive replaced by the array it
 * resolves to. The array is a literal JSON value from here on: `resolveNodeBindings`
 * passes it through untouched, so nothing in a certified output is read as a reference.
 */
export async function bindTypedOutputs(
  consumerId: string,
  withMap: Record<string, JsonValue | BindingDirective> | undefined,
  read: TypedOutputsReader
): Promise<Record<string, JsonValue | BindingDirective> | undefined> {
  if (withMap === undefined || !Object.values(withMap).some(isTypedOutputsDirective)) {
    return withMap;
  }
  const bound: Record<string, JsonValue | BindingDirective> = {};
  for (const [name, value] of Object.entries(withMap)) {
    if (!isTypedOutputsDirective(value)) {
      bound[name] = value;
      continue;
    }
    bound[name] = await resolveTypedOutputs(consumerId, name, value, read);
  }
  return bound;
}

async function resolveTypedOutputs(
  consumerId: string,
  name: string,
  directive: TypedOutputsDirective,
  read: TypedOutputsReader
): Promise<JsonValue> {
  try {
    return (await read(directive.outputs)).map(typedOutputRecord);
  } catch (error) {
    // Presence-keyed, as `if_skipped` is: `if_unreadable: null` is a declared value.
    // An output that is not JSON is its producer's defect and still fails the node.
    if (error instanceof TypedOutputsUnreadableError && Object.hasOwn(directive, 'if_unreadable')) {
      getLog().warn(
        { nodeId: consumerId, binding: name, outputType: directive.outputs, err: error },
        'typed_outputs.unreadable_default_used'
      );
      return directive.if_unreadable as JsonValue;
    }
    throw new Error(
      `Node '${consumerId}' binding '${name}' reads every '${directive.outputs}' output of this run, but ` +
        (error as Error).message
    );
  }
}
