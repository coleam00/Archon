import type { NativeTool } from '@archon/providers/types';
import { createLogger } from '@archon/paths';

const log = createLogger('orchestrator.propose_workflow_edits');

/** The five op kinds the builder's `editorReducer` vocabulary maps onto 1:1. */
export type ProposedEditOp =
  | { op: 'addNode'; id: string; variant: string; data?: Record<string, unknown> }
  | { op: 'connect'; source: string; target: string }
  | { op: 'setField'; id: string; path: string; value: unknown }
  | { op: 'rename'; id: string; nextId: string }
  | { op: 'remove'; id: string };

const KNOWN_OPS = new Set(['addNode', 'connect', 'setField', 'rename', 'remove']);
/**
 * Mirrors the console's `VariantId` union (builder/types/variant.ts) — duplicated here
 * because `@archon/core` cannot import a web package.
 *
 * Drift is guarded from the web side: `builder/variants/registry.test.ts` asserts
 * `VARIANTS` still equals this list and fails with a message naming THIS file, so
 * adding an eighth variant breaks the build here rather than silently making the
 * Copilot reject it at proposal time.
 */
const KNOWN_VARIANTS = new Set([
  'prompt',
  'command',
  'bash',
  'script',
  'loop',
  'approval',
  'cancel',
]);
/**
 * Mirrors `NODE_ID_PATTERN` in the console's `builder/editor/state.ts` — same
 * duplication reason and same drift guard as `KNOWN_VARIANTS` above.
 *
 * Validated here so a bad id is an in-turn tool error the agent can correct,
 * rather than a "success" summary the client later rejects. The reducer's
 * `add-node` silently synthesizes a `<variant>-N` id when the requested one is
 * invalid, which would desync the batch's later ops from the nodes actually
 * created.
 */
const NODE_ID_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

/**
 * Accepted `data` keys per variant — mirrors each variant's `defaultData()` in
 * the console registry, guarded by the same tripwire as `KNOWN_VARIANTS`
 * (`builder/variants/registry.test.ts`).
 *
 * Validated rather than merely documented because describing the shapes in the
 * tool description is NOT reliable: across three live Claude turns the agent
 * guessed `{"script":...}`, then `{"approval":{"message":...}}`, then
 * `{"prompt":...}`/`{"run":...}` for the same two nodes. An unknown key silently
 * produced an empty node, so the author got a proposal blocked by "must not be
 * empty" with no hint why. Rejecting here turns that into an in-turn error the
 * agent can correct on its own.
 */
const VARIANT_DATA_KEYS: Record<string, readonly string[]> = {
  prompt: ['prompt'],
  command: ['command'],
  bash: ['bash', 'timeout'],
  script: ['script', 'runtime', 'deps', 'timeout'],
  loop: [
    'prompt',
    'command',
    'until',
    'max_iterations',
    'fresh_context',
    'until_bash',
    'interactive',
    'gate_message',
  ],
  approval: ['message', 'capture_response', 'on_reject'],
  cancel: ['reason'],
};

const INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    ops: {
      type: 'string',
      description:
        'JSON array of edit ops (the whole batch as ONE array — never call this tool more ' +
        'than once per proposal). Each op is one of: ' +
        '{"op":"addNode","id":"<new-id>","variant":"prompt|command|bash|script|loop|approval|cancel","data"?:{...variant fields}}, ' +
        'Node ids must match /^[a-zA-Z_][a-zA-Z0-9_-]*$/ — letters, digits, underscore and hyphen ' +
        'only, never starting with a digit and never containing spaces (use "my_gate" or ' +
        '"my-gate", not "my gate"). ' +
        // Without this the agent guesses field names and the author gets a proposal
        // blocked by "must not be empty" errors. Note `bash` takes a field literally
        // named `bash` (NOT `script` — that is a different variant), and `approval`
        // takes `message` (NOT `prompt`); both are easy wrong guesses.
        '`data` must be a FLAT object — never nest it under the variant name. ' +
        'Copy these shapes exactly, one per variant: ' +
        'prompt → {"prompt":"..."}; ' +
        'command → {"command":"..."}; ' +
        'bash → {"bash":"<the shell script>"} (the key is "bash", not "script"); ' +
        'script → {"script":"<code>","runtime":"bun"}; ' +
        'loop → {"prompt":"...","until":"COMPLETE","max_iterations":10,"fresh_context":false}; ' +
        'approval → {"message":"..."} (the key is "message", not "prompt" and not "approval"); ' +
        'cancel → {"reason":"..."}. ' +
        'So an approval node is {"op":"addNode","id":"gate","variant":"approval",' +
        '"data":{"message":"Approve to continue?"}} — NOT ' +
        '{"data":{"approval":{"message":"..."}}}. ' +
        'Always fill the main text field when you add a node — a node left empty fails ' +
        'validation and the author cannot accept the batch. ' +
        '{"op":"connect","source":"<id>","target":"<id>"} (target depends on source), ' +
        '{"op":"setField","id":"<id>","path":"data.<field>"|"base.<field>","value":<any>}, ' +
        '{"op":"rename","id":"<id>","nextId":"<new-id>"}, ' +
        '{"op":"remove","id":"<id>"}.',
    },
    rationale: {
      type: 'string',
      description: 'One-line explanation of what this batch of edits does and why.',
    },
  },
  required: ['ops'],
};

function describeOp(op: ProposedEditOp): string {
  switch (op.op) {
    case 'addNode':
      return `add ${op.variant} node '${op.id}'`;
    case 'connect':
      return `connect ${op.source} → ${op.target}`;
    case 'setField':
      return `set ${op.id}.${op.path} = ${JSON.stringify(op.value)}`;
    case 'rename':
      return `rename ${op.id} → ${op.nextId}`;
    case 'remove':
      return `remove ${op.id}`;
  }
}

function validateOp(raw: unknown): { ok: true; op: ProposedEditOp } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'each op must be an object' };
  }
  const r = raw as Record<string, unknown>;
  const kind = typeof r.op === 'string' ? r.op : '';
  if (!KNOWN_OPS.has(kind)) {
    return {
      ok: false,
      error: `unknown op '${kind}' (expected one of ${[...KNOWN_OPS].join(', ')})`,
    };
  }
  switch (kind) {
    case 'addNode': {
      const id = typeof r.id === 'string' ? r.id : '';
      const variant = typeof r.variant === 'string' ? r.variant : '';
      if (id === '') return { ok: false, error: 'addNode requires id' };
      if (!NODE_ID_PATTERN.test(id)) {
        return { ok: false, error: `addNode: id '${id}' must match ${NODE_ID_PATTERN.source}` };
      }
      if (!KNOWN_VARIANTS.has(variant)) {
        return { ok: false, error: `addNode: unknown variant '${variant}'` };
      }
      const data =
        typeof r.data === 'object' && r.data !== null
          ? (r.data as Record<string, unknown>)
          : undefined;
      if (data !== undefined) {
        const allowed = VARIANT_DATA_KEYS[variant] ?? [];
        const unknown = Object.keys(data).filter(k => !allowed.includes(k));
        if (unknown.length > 0) {
          return {
            ok: false,
            error:
              `addNode '${id}': ${variant} data does not accept ` +
              `${unknown.map(k => `'${k}'`).join(', ')}. ` +
              `Use a flat object with only: ${allowed.join(', ')}.`,
          };
        }
      }
      return { ok: true, op: { op: 'addNode', id, variant, data } };
    }
    case 'connect': {
      const source = typeof r.source === 'string' ? r.source : '';
      const target = typeof r.target === 'string' ? r.target : '';
      if (source === '' || target === '') {
        return { ok: false, error: 'connect requires source and target' };
      }
      return { ok: true, op: { op: 'connect', source, target } };
    }
    case 'setField': {
      const id = typeof r.id === 'string' ? r.id : '';
      const path = typeof r.path === 'string' ? r.path : '';
      if (id === '' || path === '') {
        return { ok: false, error: 'setField requires id and path' };
      }
      if (!path.startsWith('data.') && !path.startsWith('base.')) {
        return {
          ok: false,
          error: `setField: path must start with 'data.' or 'base.' (got '${path}')`,
        };
      }
      return { ok: true, op: { op: 'setField', id, path, value: r.value } };
    }
    case 'rename': {
      const id = typeof r.id === 'string' ? r.id : '';
      const nextId = typeof r.nextId === 'string' ? r.nextId : '';
      if (id === '' || nextId === '') {
        return { ok: false, error: 'rename requires id and nextId' };
      }
      if (!NODE_ID_PATTERN.test(nextId)) {
        return {
          ok: false,
          error: `rename: nextId '${nextId}' must match ${NODE_ID_PATTERN.source}`,
        };
      }
      return { ok: true, op: { op: 'rename', id, nextId } };
    }
    case 'remove': {
      const id = typeof r.id === 'string' ? r.id : '';
      if (id === '') return { ok: false, error: 'remove requires id' };
      return { ok: true, op: { op: 'remove', id } };
    }
    default:
      // Unreachable — kind is narrowed to a KNOWN_OPS member above.
      return { ok: false, error: `unknown op '${kind}'` };
  }
}

/** Parse + validate a `propose_workflow_edits` `ops` string. Never throws. */
export function parseAndValidateOps(
  json: string
): { ok: true; ops: ProposedEditOp[] } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e: unknown) {
    return { ok: false, error: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: 'ops must be a JSON array' };
  if (parsed.length === 0) return { ok: false, error: 'ops must be a non-empty array' };

  const ops: ProposedEditOp[] = [];
  for (const [i, raw] of parsed.entries()) {
    const result = validateOp(raw);
    if (!result.ok) return { ok: false, error: `op[${i.toString()}]: ${result.error}` };
    ops.push(result.op);
  }
  return { ok: true, ops };
}

/** Human-readable one-line-per-batch summary, echoed back to the agent/chat log. */
export function summarizeProposal(ops: ProposedEditOp[]): string {
  const lines = ops.map(describeOp);
  return `Proposed ${ops.length.toString()} edit${ops.length === 1 ? '' : 's'}: ${lines.join('; ')}`;
}

/**
 * The `propose_workflow_edits` native tool — a direct sibling of `manage_run`
 * (`manage-run-tool.ts`), gated into builder-mode chats only
 * (`orchestrator-agent.ts`). Unlike `manage_run`, this tool performs NO
 * mutation and closes over no live context: it only validates the agent's
 * proposed batch and returns a text summary. The ops themselves reach the
 * client via the tool-call's `input.ops` (read off the completed assistant
 * message, per Pre-flight #2) — the builder canvas applies them through the
 * real `editorReducer` after the author Accepts. Errors are returned as text,
 * never thrown, per the `NativeTool` contract.
 */
export function buildProposeWorkflowEditsTool(): NativeTool {
  return {
    name: 'propose_workflow_edits',
    description:
      'Propose a batch of edits to the workflow currently open on the builder canvas. You do ' +
      'NOT apply them — the author previews the whole batch and Accepts or Rejects it. Call ' +
      'this ONCE per proposal with the full batch as a JSON array in `ops`. Never edit the ' +
      "workflow's YAML file directly or run bash to change it — that bypasses the preview/accept " +
      'gate this tool exists for.',
    inputSchema: INPUT_SCHEMA,
    handler: async (input): Promise<string> => {
      const raw = typeof input.ops === 'string' ? input.ops : '';
      if (raw === '') {
        return 'propose_workflow_edits: ops is required (a JSON array, encoded as a string).';
      }
      const parsed = parseAndValidateOps(raw);
      if (!parsed.ok) {
        log.warn({ error: parsed.error }, 'propose_workflow_edits.invalid_ops');
        return `Invalid ops: ${parsed.error}`;
      }
      log.info({ count: parsed.ops.length }, 'propose_workflow_edits.proposed');
      const rationale = typeof input.rationale === 'string' ? input.rationale.trim() : '';
      const summary = summarizeProposal(parsed.ops);
      return rationale.length > 0 ? `${summary}\n\n${rationale}` : summary;
    },
  };
}
