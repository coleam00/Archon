import {
  workflowRunConfigLayerSchema,
  workflowRunConfigMetadataSchema,
  type WorkflowRunConfigInput,
  type WorkflowRunConfigLayer,
  type WorkflowRunConfigMetadata,
} from '@archon/workflows/schemas/run-config';
import { decryptToken, getEncryptionKey } from '../utils/token-crypto';

/** Decrypt and structurally validate a sealed layer without loading provider semantics. */
export function unsealWorkflowRunConfigStructure(
  metadata: WorkflowRunConfigMetadata
): WorkflowRunConfigLayer {
  let plaintext: string;
  try {
    plaintext = decryptToken(metadata.ciphertext, getEncryptionKey());
  } catch {
    throw new Error('Workflow run config could not be decrypted.');
  }

  let value: unknown;
  try {
    value = JSON.parse(plaintext) as unknown;
  } catch {
    throw new Error('Workflow run config payload is not valid JSON.');
  }

  const parsed = workflowRunConfigLayerSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('Workflow run config payload is invalid.');
  }
  return parsed.data;
}

/** Decode the detached parent handoff before command/provider dispatch. */
export function decodeWorkflowRunConfigHandoff(payload: string): WorkflowRunConfigInput {
  let value: unknown;
  try {
    value = JSON.parse(payload) as unknown;
  } catch {
    throw new Error('Detached workflow run config payload is not valid JSON.');
  }

  const metadata = workflowRunConfigMetadataSchema.safeParse(value);
  if (!metadata.success) {
    throw new Error('Detached workflow run config payload is invalid.');
  }

  return {
    layer: unsealWorkflowRunConfigStructure(metadata.data),
    source: metadata.data.source,
  };
}
