/**
 * Resolution of typed-outputs bindings: `with: { <name>: { outputs: <output_type> } }` on a
 * script node becomes the JSON array of every certified output of that type the run has
 * produced, in production order.
 *
 * A record that cannot be read fails the binding and names the record. An unreadable
 * sidecar has no trustworthy type, so it might be one of the outputs asked for; dropping
 * it would hand the script a shorter list that looks complete.
 */
import { join } from 'node:path';
import { readArtifactFile } from './artifact-writes';
import { readNodeArtifacts } from './artifacts-index';
import type { JsonValue } from './output-ref';
import type { NodeArtifact } from './schemas/node-artifact';
import {
  isTypedOutputsDirective,
  type BindingDirective,
  type TypedOutputRecord,
} from './schemas/node-bindings';

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
      throw new Error(`the run has typed-output records that cannot be read: ${named.join('; ')}`);
    }
    const recorded: RecordedTypedOutput[] = [];
    // `Object.hasOwn`: an output type is an open string and must not resolve an inherited key.
    for (const artifact of Object.hasOwn(artifactsByType, outputType)
      ? artifactsByType[outputType]
      : []) {
      const text = await readArtifactFile(join(artifactsDir, artifact.path));
      if (text === undefined) throw new Error(`${artifact.path} cannot be read`);
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
    try {
      bound[name] = (await read(value.outputs)).map(typedOutputRecord);
    } catch (error) {
      throw new Error(
        `Node '${consumerId}' binding '${name}' reads every '${value.outputs}' output of this run, but ` +
          (error as Error).message
      );
    }
  }
  return bound;
}
