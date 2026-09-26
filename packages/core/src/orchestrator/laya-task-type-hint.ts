import path from 'node:path';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import type { Agent } from './vendor/laya-ts/agent';
import requiredCheckpointVerification from './laya-checkpoint-verification.json' with { type: 'json' };
import { ORCHESTRATOR_TASK_TYPES, type OrchestratorTaskType } from './task-types';

const TASK_TYPE_CRITERIA: Record<OrchestratorTaskType, string> = {
  question:
    'A general explanation, discussion, or advice request that does not explicitly ask to work on an existing project or operate an existing workflow run.',
  project_work:
    'An explicit request to plan, implement, change, review, or run tests against an existing project.',
  project_setup: 'A request to register, clone, select, switch, or remove a project.',
  run_management:
    'A request about the status, approval, resumption, cancellation, or abandonment of an already-created workflow run.',
  unclear: 'The requested kind of work is ambiguous or depends on missing context.',
};

const TASK_TYPE_QUESTION = {
  task_type: {
    type: 'choice',
    instructions:
      'Classify the current message by the requested work. Apply these distinctions: register, clone, select, switch, or remove a project is project_setup; managing an already-created workflow run is run_management; directly planning or changing an existing project, reviewing it, or running its tests is project_work; conceptual questions such as “How would I add retries?” are question. “Run the tests in this project” is project_work; “resume that workflow run” is run_management. Use unclear when the intent remains ambiguous. Use prior turns only to resolve references and follow-ups; the current message controls the requested work. This advisory selects only among configured direct-chat routes and can never dispatch a workflow. Do not infer permissions, project access, provider choice, or whether an action is authorized.',
    criteria: TASK_TYPE_CRITERIA,
  },
} as const;

export type { OrchestratorTaskType } from './task-types';

export interface LayaTaskTypeHint {
  taskType: OrchestratorTaskType;
  probability: number;
}

export interface LayaTaskTypeContextTurn {
  role: 'user' | 'assistant';
  content: string;
}

type LocalLaya = Pick<Agent, 'systemOne'>;
type LocalLayaLoader = (modelDir: string) => Promise<LocalLaya>;
const LOCAL_BUNDLE_FILES = [
  'encoder.onnx',
  'head.onnx',
  'rl_agent_config.json',
  'tokenizer.json',
] as const;
const LOCAL_BUNDLE_MANIFEST = 'laya-bundle-manifest.json';
const PINNED_LAYA_TS_COMMIT = '4066d5d5fbf08b66c6757ddeedbd797bd7655bc0';
const PINNED_MODEL_SOURCE =
  'https://www.modelscope.cn/models/convaiinnovations/laya/typed-decisions';
const PINNED_MODEL_REVISION = '69f17eefb6910e69dbb031dcc3c8e3f556cff267';
const PINNED_MODEL_LICENSE = 'Apache-2.0';
const PINNED_EXPORTER_REPOSITORY = 'NandhaKishorM/laya';
const PINNED_EXPORTER_COMMIT = '23a17522aa4942da6cce53a995a275760320b691';
const REQUIRED_CHECKPOINT_VERIFICATION = requiredCheckpointVerification;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_LOCAL_BUNDLE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_ONNX_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_TOKENIZER_BYTES = 64 * 1024 * 1024;
const LOCAL_BUNDLE_FILE_LIMITS: Record<(typeof LOCAL_BUNDLE_FILES)[number], number> = {
  'encoder.onnx': MAX_ONNX_BYTES,
  'head.onnx': MAX_ONNX_BYTES,
  'rl_agent_config.json': MAX_CONFIG_BYTES,
  'tokenizer.json': MAX_TOKENIZER_BYTES,
};
const MAX_CLASSIFIER_INPUT_CHARS = 2_048;
const MAX_CLASSIFIER_CONTEXT_TURNS = 6;
const MAX_CLASSIFIER_CONTEXT_CHARS = 1_024;
const CLASSIFICATION_DEADLINE_MS = 2_500;
const MIN_TASK_TYPE_PROBABILITY = 0.75;

function boundContextTurns(turns: readonly LayaTaskTypeContextTurn[]): LayaTaskTypeContextTurn[] {
  const recent = turns
    .filter(
      turn =>
        (turn.role === 'user' || turn.role === 'assistant') &&
        typeof turn.content === 'string' &&
        turn.content.trim().length > 0
    )
    .slice(-MAX_CLASSIFIER_CONTEXT_TURNS);
  const bounded: LayaTaskTypeContextTurn[] = [];
  let remaining = MAX_CLASSIFIER_CONTEXT_CHARS;

  for (let index = recent.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const turn = recent[index];
    if (!turn) continue;
    const content = turn.content.slice(-remaining);
    bounded.unshift({ role: turn.role, content });
    remaining -= content.length;
  }

  return bounded;
}

interface LocalBundleManifest {
  schemaVersion: 1;
  runtimeCommit: string;
  exporter: { repository: string; commit: string };
  checkpointVerification: typeof REQUIRED_CHECKPOINT_VERIFICATION;
  model: {
    source: string;
    revision: string;
    license: string;
    approvalStatus: 'approved';
    approvalReference: string;
  };
  files: Record<(typeof LOCAL_BUNDLE_FILES)[number], { sha256: string; sizeBytes: number }>;
}

async function sha256File(
  filePath: string,
  maxBytes: number
): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash('sha256');
  let sizeBytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    sizeBytes += chunk.byteLength;
    if (sizeBytes > maxBytes) throw new Error('local Laya bundle file exceeds its size limit');
    hash.update(chunk);
  }
  return { sha256: hash.digest('hex'), sizeBytes };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasRequiredCheckpointVerification(
  value: unknown
): value is typeof REQUIRED_CHECKPOINT_VERIFICATION {
  return (
    isRecord(value) &&
    Object.keys(value).length === Object.keys(REQUIRED_CHECKPOINT_VERIFICATION).length &&
    value.schemaVersion === REQUIRED_CHECKPOINT_VERIFICATION.schemaVersion &&
    value.method === REQUIRED_CHECKPOINT_VERIFICATION.method &&
    value.tensorCount === REQUIRED_CHECKPOINT_VERIFICATION.tensorCount &&
    value.sourceDtype === REQUIRED_CHECKPOINT_VERIFICATION.sourceDtype &&
    value.loadDtype === REQUIRED_CHECKPOINT_VERIFICATION.loadDtype &&
    value.exportDtype === REQUIRED_CHECKPOINT_VERIFICATION.exportDtype &&
    value.loadStrict === REQUIRED_CHECKPOINT_VERIFICATION.loadStrict
  );
}

function parseLocalBundleManifest(value: unknown): LocalBundleManifest | undefined {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.runtimeCommit !== PINNED_LAYA_TS_COMMIT ||
    !hasRequiredCheckpointVerification(value.checkpointVerification)
  ) {
    return undefined;
  }
  const model = value.model;
  const exporter = value.exporter;
  const files = value.files;
  const normalizedSource =
    isRecord(model) && typeof model.source === 'string' ? model.source.toLowerCase() : '';
  const compactSource = normalizedSource.replace(/[^a-z0-9]/g, '');
  const identifiesHuggingFace =
    compactSource.includes('huggingface') ||
    compactSource === 'hf' ||
    compactSource.startsWith('hfco') ||
    compactSource.startsWith('hfhub');
  if (
    !isRecord(model) ||
    model.source !== PINNED_MODEL_SOURCE ||
    model.revision !== PINNED_MODEL_REVISION ||
    model.license !== PINNED_MODEL_LICENSE ||
    model.approvalStatus !== 'approved' ||
    typeof model.approvalReference !== 'string' ||
    !model.approvalReference.trim() ||
    model.approvalReference.length > 512 ||
    identifiesHuggingFace ||
    !isRecord(exporter) ||
    exporter.repository !== PINNED_EXPORTER_REPOSITORY ||
    exporter.commit !== PINNED_EXPORTER_COMMIT ||
    !isRecord(files) ||
    Object.keys(files).length !== LOCAL_BUNDLE_FILES.length
  ) {
    return undefined;
  }

  const normalizedFiles: LocalBundleManifest['files'] = {} as LocalBundleManifest['files'];
  for (const file of LOCAL_BUNDLE_FILES) {
    const entry = files[file];
    if (
      !isRecord(entry) ||
      typeof entry.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(entry.sha256) ||
      !Number.isSafeInteger(entry.sizeBytes) ||
      (entry.sizeBytes as number) <= 0 ||
      (entry.sizeBytes as number) > LOCAL_BUNDLE_FILE_LIMITS[file]
    ) {
      return undefined;
    }
    normalizedFiles[file] = {
      sha256: entry.sha256.toLowerCase(),
      sizeBytes: entry.sizeBytes as number,
    };
  }

  return {
    schemaVersion: 1,
    runtimeCommit: PINNED_LAYA_TS_COMMIT,
    exporter: {
      repository: PINNED_EXPORTER_REPOSITORY,
      commit: PINNED_EXPORTER_COMMIT,
    },
    checkpointVerification: REQUIRED_CHECKPOINT_VERIFICATION,
    model: {
      source: PINNED_MODEL_SOURCE,
      revision: PINNED_MODEL_REVISION,
      license: PINNED_MODEL_LICENSE,
      approvalStatus: 'approved',
      approvalReference: model.approvalReference.trim(),
    },
    files: normalizedFiles,
  };
}

async function assertCompleteLocalBundle(
  modelDir: string,
  expectedManifestSha256: string
): Promise<LocalBundleManifest> {
  if (!path.isAbsolute(modelDir) || !/^[a-f0-9]{64}$/i.test(expectedManifestSha256)) {
    throw new Error('an absolute local model path and pinned manifest SHA-256 are required');
  }
  try {
    if (!(await lstat(modelDir)).isDirectory()) {
      throw new Error('not a directory');
    }
  } catch {
    throw new Error('Configured local Laya model directory is missing or invalid');
  }

  const manifestPath = path.join(modelDir, LOCAL_BUNDLE_MANIFEST);
  let manifestBytes: Buffer;
  try {
    const manifestInfo = await lstat(manifestPath);
    if (
      !manifestInfo.isFile() ||
      manifestInfo.size <= 0 ||
      manifestInfo.size > MAX_MANIFEST_BYTES
    ) {
      throw new Error('invalid manifest file');
    }
    manifestBytes = await readFile(manifestPath);
  } catch {
    throw new Error('Configured local Laya bundle manifest is missing or invalid');
  }
  const expectedDigest = expectedManifestSha256.toLowerCase();
  if (createHash('sha256').update(manifestBytes).digest('hex') !== expectedDigest) {
    throw new Error('Configured local Laya bundle manifest digest does not match its approved pin');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new Error('Configured local Laya bundle manifest is invalid');
  }
  const manifest = parseLocalBundleManifest(parsed);
  if (!manifest) throw new Error('Configured local Laya bundle manifest is invalid');

  const declaredBundleBytes =
    manifestBytes.byteLength +
    LOCAL_BUNDLE_FILES.reduce((total, file) => total + manifest.files[file].sizeBytes, 0);
  if (declaredBundleBytes > MAX_LOCAL_BUNDLE_BYTES) {
    throw new Error('Configured local Laya bundle exceeds its aggregate size limit');
  }

  let totalBundleBytes = manifestBytes.byteLength;
  for (const file of LOCAL_BUNDLE_FILES) {
    const filePath = path.join(modelDir, file);
    let fileInfo;
    try {
      fileInfo = await lstat(filePath);
    } catch {
      throw new Error(`Configured local Laya bundle file is missing or invalid: ${file}`);
    }
    if (
      !fileInfo.isFile() ||
      fileInfo.size <= 0 ||
      fileInfo.size > LOCAL_BUNDLE_FILE_LIMITS[file]
    ) {
      throw new Error(`Configured local Laya bundle file is missing or invalid: ${file}`);
    }

    const remainingBundleBytes = MAX_LOCAL_BUNDLE_BYTES - totalBundleBytes;
    if (fileInfo.size > remainingBundleBytes) {
      throw new Error('Configured local Laya bundle exceeds its aggregate size limit');
    }

    let actual: { sha256: string; sizeBytes: number };
    try {
      actual = await sha256File(
        filePath,
        Math.min(LOCAL_BUNDLE_FILE_LIMITS[file], remainingBundleBytes)
      );
    } catch {
      throw new Error(`Configured local Laya bundle file is missing or invalid: ${file}`);
    }
    const expected = manifest.files[file];
    if (actual.sizeBytes !== expected.sizeBytes || actual.sha256 !== expected.sha256) {
      throw new Error(`Configured local Laya bundle file is missing or invalid: ${file}`);
    }
    totalBundleBytes += actual.sizeBytes;
  }
  return manifest;
}

async function createVerifiedLocalBundleSnapshot(
  modelDir: string,
  expectedManifestSha256: string
): Promise<{ modelDir: string; cleanup: () => Promise<void> }> {
  const manifest = await assertCompleteLocalBundle(modelDir, expectedManifestSha256);
  const snapshotDir = await mkdtemp(path.join(tmpdir(), 'archon-laya-'));
  try {
    for (const file of LOCAL_BUNDLE_FILES) {
      const snapshotPath = path.join(snapshotDir, file);
      await copyFile(path.join(modelDir, file), snapshotPath, constants.COPYFILE_EXCL);
      const snapshot = await sha256File(snapshotPath, LOCAL_BUNDLE_FILE_LIMITS[file]);
      const expected = manifest.files[file];
      if (snapshot.sizeBytes !== expected.sizeBytes || snapshot.sha256 !== expected.sha256) {
        throw new Error(`Configured local Laya bundle file changed while staging: ${file}`);
      }
      await chmod(snapshotPath, 0o400);
    }
    await chmod(snapshotDir, 0o500);

    return {
      modelDir: snapshotDir,
      cleanup: async (): Promise<void> => {
        await chmod(snapshotDir, 0o700);
        await rm(snapshotDir, { recursive: true, force: true });
      },
    };
  } catch {
    await chmod(snapshotDir, 0o700).catch(() => undefined);
    await rm(snapshotDir, { recursive: true, force: true }).catch(() => undefined);
    throw new Error('Configured local Laya bundle could not be staged as a verified snapshot');
  }
}

async function loadLocalLaya(modelDir: string): Promise<LocalLaya> {
  const { Agent: layaAgent } = await import('./vendor/laya-ts/agent');
  return layaAgent.load(modelDir, { numThreads: Math.min(2, availableParallelism()) });
}

/**
 * Build a local-only, lazy Laya hint resolver. An explicit local model directory
 * is required; the vendored loader reads a split ONNX bundle from disk and has no
 * network loader. A load or inference error disables this advisory for the process
 * and is surfaced to the caller once.
 */
export function createLayaTaskTypeHintResolver(
  options: {
    enabled?: boolean;
    modelDir?: string | null;
    modelManifestSha256?: string | null;
    loadModel?: LocalLayaLoader;
    timeoutMs?: number;
  } = {}
): (
  message: string,
  contextTurns?: readonly LayaTaskTypeContextTurn[]
) => Promise<LayaTaskTypeHint | undefined> {
  const enabled = options.enabled ?? process.env.ARCHON_LAYA_TASK_HINTS === '1';
  const configuredDir =
    options.modelDir === undefined ? process.env.ARCHON_LAYA_MODEL_DIR : options.modelDir;
  const configuredPath = configuredDir?.trim();
  const modelDir =
    configuredPath && path.isAbsolute(configuredPath) ? path.resolve(configuredPath) : undefined;
  const expectedManifestSha256 =
    options.modelManifestSha256 === undefined
      ? process.env.ARCHON_LAYA_MODEL_MANIFEST_SHA256
      : options.modelManifestSha256;
  const loadModel = options.loadModel ?? loadLocalLaya;
  let modelPromise: Promise<LocalLaya> | undefined;
  let unavailable = false;
  let busy = false;

  return async (message, contextTurns = []): Promise<LayaTaskTypeHint | undefined> => {
    const text = message.trim().slice(0, MAX_CLASSIFIER_INPUT_CHARS);
    if (!enabled || !modelDir || !expectedManifestSha256?.trim() || !text || unavailable || busy) {
      return undefined;
    }
    const boundedContext = boundContextTurns(contextTurns);

    busy = true;
    const classification = (async (): Promise<LayaTaskTypeHint | undefined> => {
      modelPromise ??= (async (): Promise<LocalLaya> => {
        const snapshot = await createVerifiedLocalBundleSnapshot(
          modelDir,
          expectedManifestSha256.trim()
        );
        try {
          return await loadModel(snapshot.modelDir);
        } finally {
          await snapshot.cleanup();
        }
      })();
      const model = await modelPromise;
      const result = await model.systemOne(
        {
          message: text,
          ...(boundedContext.length > 0 ? { conversation_context: boundedContext } : {}),
        },
        TASK_TYPE_QUESTION
      );
      const answer = result.answers.task_type;
      if (answer?.type !== 'choice') {
        throw new Error('Local Laya returned an invalid task-type decision');
      }
      const taskType = answer.choice;
      const probability = answer.probabilities[taskType];
      if (
        !ORCHESTRATOR_TASK_TYPES.includes(taskType as OrchestratorTaskType) ||
        typeof probability !== 'number' ||
        !Number.isFinite(probability) ||
        probability < 0 ||
        probability > 1
      ) {
        throw new Error('Local Laya returned an invalid task-type decision');
      }
      // This conservative cutoff suppresses weak hints; it is not a calibrated
      // correctness or safety guarantee and does not replace held-out evaluation.
      if (probability < MIN_TASK_TYPE_PROBABILITY) return undefined;
      return { taskType: taskType as OrchestratorTaskType, probability };
    })();

    // The deadline bounds how long the chat turn waits, not the native ONNX
    // operation. Keep the process-local single-flight lock until that actual
    // promise settles, and consume any late rejection after a timed-out turn.
    void classification.then(
      () => {
        busy = false;
      },
      () => {
        unavailable = true;
        busy = false;
      }
    );

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Promise<undefined>(resolve => {
        timeout = setTimeout(() => {
          resolve(undefined);
        }, options.timeoutMs ?? CLASSIFICATION_DEADLINE_MS);
      });
      try {
        return await Promise.race([classification, timedOut]);
      } catch {
        // Laya/ONNX errors can contain local paths or request-derived details.
        throw new Error('Local Laya advisory is unavailable');
      }
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  };
}

const resolveLocalLayaTaskTypeHint = createLayaTaskTypeHintResolver();

export function isLayaTaskTypeHintsEnabled(): boolean {
  const modelDir = process.env.ARCHON_LAYA_MODEL_DIR?.trim();
  return (
    process.env.ARCHON_LAYA_TASK_HINTS === '1' &&
    Boolean(modelDir && path.isAbsolute(modelDir)) &&
    /^[a-f0-9]{64}$/i.test(process.env.ARCHON_LAYA_MODEL_MANIFEST_SHA256?.trim() ?? '')
  );
}

export function getLayaTaskTypeHint(
  message: string,
  contextTurns?: readonly LayaTaskTypeContextTurn[]
): Promise<LayaTaskTypeHint | undefined> {
  return resolveLocalLayaTaskTypeHint(message, contextTurns);
}

export function formatLayaTaskTypeHint(hint?: LayaTaskTypeHint): string {
  if (!hint) return '';

  return [
    '## Local Task-Type Hint',
    '',
    `A local Laya classifier suggests **${hint.taskType}** (probability ${hint.probability.toFixed(2)}).`,
    'This is advisory only. Interpret the full conversation and follow the user’s explicit request and the routing rules below. If install routing is enabled, Archon may use a high-confidence label only to select an explicitly configured direct-chat model route when the user has not pinned a provider or model. This hint cannot select or dispatch a workflow, choose a project, authorize an action, or change credentials, validation, or approval requirements.',
  ].join('\n');
}
