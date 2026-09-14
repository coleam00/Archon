import { expect, test } from 'bun:test';
import { z } from '@hono/zod-openapi';
import type { DagNode } from './schemas';
import {
  bindingDirectiveSchema,
  dagNodeFlatSchema,
  dagNodeSchema,
  WORKFLOW_HOOK_EVENTS,
} from './schemas';
import type { TemplateSlotName, TemplateSurface } from './template-walker';
import {
  mapNodeTemplateSlots,
  mapNodeTemplateValueSlots,
  SLOT_SPEC,
  visitNodeTemplateSlots,
} from './template-walker';

type StringFieldClassification =
  | { kind: 'template'; slots: readonly TemplateSlotName[] }
  | { kind: 'literal'; reason: string };

const HOOK_MATCHER_REASON = 'Hook matcher is an SDK regex, not execution template text';
const HOOK_RESPONSE_REASON = 'Hook response is static provider configuration';
const HOOK_FIELD_CLASSIFICATIONS = Object.fromEntries(
  WORKFLOW_HOOK_EVENTS.flatMap(event => [
    [`hooks.${event}.*.matcher`, { kind: 'literal', reason: HOOK_MATCHER_REASON }] as const,
    [`hooks.${event}.*.response.*`, { kind: 'literal', reason: HOOK_RESPONSE_REASON }] as const,
  ])
) satisfies Record<string, StringFieldClassification>;

const STRING_FIELD_CLASSIFICATIONS = {
  id: { kind: 'literal', reason: 'Node identifier anchors graph edges and output references' },
  description: { kind: 'literal', reason: 'Node documentation is not execution input' },
  'depends_on.*': { kind: 'literal', reason: 'Dependency entries are node identifiers' },
  when: { kind: 'template', slots: ['when'] },
  trigger_rule: { kind: 'literal', reason: 'Trigger rule is a scheduling policy enum' },
  model: { kind: 'literal', reason: 'Model is a provider model identifier' },
  provider: { kind: 'literal', reason: 'Provider is an integration identifier' },
  context: { kind: 'literal', reason: 'Context string selects a session policy' },
  'context.resume': { kind: 'literal', reason: 'Resume target is a node identifier' },
  'output_format.*': {
    kind: 'literal',
    reason: 'Output-format values declare a JSON schema rather than runtime template input',
  },
  'allowed_tools.*': { kind: 'literal', reason: 'Allowed-tool entries are capability names' },
  'denied_tools.*': { kind: 'literal', reason: 'Denied-tool entries are capability names' },
  'retry.on_error': { kind: 'literal', reason: 'Retry error class is an engine policy enum' },
  ...HOOK_FIELD_CLASSIFICATIONS,
  mcp: { kind: 'literal', reason: 'MCP value is a configuration path' },
  'skills.*': { kind: 'literal', reason: 'Skill entries are capability identifiers' },
  'agents.*.description': { kind: 'template', slots: ['agents.*.description'] },
  'agents.*.prompt': { kind: 'template', slots: ['agents.*.prompt'] },
  'agents.*.model': { kind: 'literal', reason: 'Sub-agent model is a provider identifier' },
  'agents.*.tools.*': { kind: 'literal', reason: 'Sub-agent tool entries are capability names' },
  'agents.*.disallowedTools.*': {
    kind: 'literal',
    reason: 'Sub-agent denied-tool entries are capability names',
  },
  'agents.*.skills.*': {
    kind: 'literal',
    reason: 'Sub-agent skill entries are capability identifiers',
  },
  'pi.extensionFlags.*': { kind: 'literal', reason: 'Pi extension flag values configure plugins' },
  effort: { kind: 'literal', reason: 'Effort is a provider reasoning-level enum' },
  systemPrompt: { kind: 'template', slots: ['systemPrompt'] },
  fallbackModel: { kind: 'literal', reason: 'Fallback model is a provider model identifier' },
  'settingSources.*': { kind: 'literal', reason: 'Setting sources select provider config layers' },
  'betas.*': { kind: 'literal', reason: 'Beta entries are provider feature identifiers' },
  'sandbox.network.allowedDomains.*': {
    kind: 'literal',
    reason: 'Allowed domains are sandbox network rules',
  },
  'sandbox.network.allowUnixSockets.*': {
    kind: 'literal',
    reason: 'Allowed Unix sockets are sandbox paths',
  },
  'sandbox.filesystem.allowWrite.*': {
    kind: 'literal',
    reason: 'Allowed-write entries are sandbox filesystem paths',
  },
  'sandbox.filesystem.denyWrite.*': {
    kind: 'literal',
    reason: 'Denied-write entries are sandbox filesystem paths',
  },
  'sandbox.filesystem.denyRead.*': {
    kind: 'literal',
    reason: 'Denied-read entries are sandbox filesystem paths',
  },
  'sandbox.ignoreViolations.*.*': {
    kind: 'literal',
    reason: 'Ignored violations are provider sandbox rule names',
  },
  'sandbox.excludedCommands.*': {
    kind: 'literal',
    reason: 'Excluded commands are sandbox executable names',
  },
  'sandbox.ripgrep.command': {
    kind: 'literal',
    reason: 'Ripgrep command is a sandbox executable path',
  },
  'sandbox.ripgrep.args.*': {
    kind: 'literal',
    reason: 'Ripgrep arguments are static sandbox configuration',
  },
  'sandbox.*': {
    kind: 'literal',
    reason: 'Unmodelled sandbox values pass through as provider configuration',
  },
  output_type: { kind: 'literal', reason: 'Output type is an artifact classification tag' },
  command: { kind: 'literal', reason: 'Resource identifier resolved before execution' },
  prompt: { kind: 'template', slots: ['agent.prompt'] },
  bash: { kind: 'template', slots: ['exec.bash'] },
  'loop.until': { kind: 'literal', reason: 'Loop completion signal is matched verbatim' },
  'loop.until_bash': { kind: 'template', slots: ['loop.until_bash'] },
  'loop.gate_message': {
    kind: 'literal',
    reason: 'Interactive-loop gate message is operator display text',
  },
  'loop.prompt': { kind: 'template', slots: ['loop.prompt'] },
  'loop.command': { kind: 'literal', reason: 'Loop command is a resource identifier' },
  'loop.until_field': {
    kind: 'literal',
    reason: 'Loop completion field names an output-schema property',
  },
  'loop_group.until': {
    kind: 'literal',
    reason: 'Loop-group completion signal is matched verbatim',
  },
  'loop_group.until_bash': { kind: 'template', slots: ['loop_group.until_bash'] },
  'loop_group.gate_message': {
    kind: 'literal',
    reason: 'Loop-group gate message is operator display text',
  },
  'approval.message': { kind: 'template', slots: ['approval.message'] },
  'approval.decisions.*.id': {
    kind: 'literal',
    reason: 'Approval decision id is a response wire value',
  },
  'approval.decisions.*.label': {
    kind: 'literal',
    reason: 'Display text is not an execution template',
  },
  'approval.on_reject.prompt': { kind: 'template', slots: ['approval.on_reject.prompt'] },
  'wait.until': { kind: 'template', slots: ['wait.until'] },
  'wait.event': { kind: 'template', slots: ['wait.event'] },
  'wait.attention': { kind: 'template', slots: ['wait.attention'] },
  cancel: { kind: 'template', slots: ['cancel.reason'] },
  include: { kind: 'literal', reason: 'Include target is a workflow resource identifier' },
  workflow: { kind: 'literal', reason: 'Child target is a workflow resource identifier' },
  input: { kind: 'template', slots: ['workflow.input'] },
  isolation: { kind: 'literal', reason: 'Isolation is a child-run placement policy enum' },
  'fan_out.items': {
    kind: 'template',
    slots: ['workflow.fan_out.items', 'compose_fan_out.fan_out.items'],
  },
  'fan_out.as': { kind: 'literal', reason: 'Fan-out alias is an input identifier' },
  'fan_out.join': { kind: 'literal', reason: 'Fan-out join is an execution policy enum' },
  'with.*': {
    kind: 'template',
    slots: ['binding.value', 'workflow.with.*', 'compose_fan_out.with.*'],
  },
  'with.*.from': { kind: 'template', slots: ['binding.from'] },
  'with.*.if_skipped': { kind: 'template', slots: ['binding.if_skipped'] },
  script: { kind: 'template', slots: ['exec.script'] },
  runtime: { kind: 'literal', reason: 'Script runtime is an executor identifier' },
  on_timeout: { kind: 'literal', reason: 'Timeout outcome is an execution policy enum' },
  'deps.*': { kind: 'literal', reason: 'Script dependencies are package identifiers' },
} satisfies Record<string, StringFieldClassification>;

const ENGINE_PRIVATE_SLOT_REASONS = {
  'loop.compiled_prompt': 'Loaded loop commands are compiled after authoring validation',
  'composed.inputs.*': 'Materialized include inputs live only in engine metadata',
} satisfies Partial<Record<TemplateSlotName, string>>;

interface StringFieldInventory {
  stringFields: readonly string[];
  followedReferences: readonly string[];
}

interface CompletenessProblems {
  unclassifiedStringFields: readonly string[];
  classificationsWithoutStringFields: readonly string[];
  templateSlotsMissingFromCatalogue: readonly string[];
  schemaBackedSlotsWithoutClassification: readonly string[];
  enginePrivateSlotsMissingFromCatalogue: readonly string[];
  literalFieldsWithoutReasons: readonly string[];
  enginePrivateSlotsWithoutReasons: readonly string[];
}

const EMPTY_COMPLETENESS_PROBLEMS: CompletenessProblems = {
  unclassifiedStringFields: [],
  classificationsWithoutStringFields: [],
  templateSlotsMissingFromCatalogue: [],
  schemaBackedSlotsWithoutClassification: [],
  enginePrivateSlotsMissingFromCatalogue: [],
  literalFieldsWithoutReasons: [],
  enginePrivateSlotsWithoutReasons: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function childPath(parent: string, child: string): string {
  return parent === '' ? child : `${parent}.${child}`;
}

function resolveLocalReference(root: unknown, reference: string): unknown {
  if (reference === '#') return root;
  if (!reference.startsWith('#/'))
    throw new Error(`Unsupported JSON Schema reference: ${reference}`);

  let current = root;
  for (const encodedToken of reference.slice(2).split('/')) {
    if (!isRecord(current)) throw new Error(`JSON Schema reference does not resolve: ${reference}`);
    const token = decodeURIComponent(encodedToken).replaceAll('~1', '/').replaceAll('~0', '~');
    current = current[token];
  }
  if (current === undefined)
    throw new Error(`JSON Schema reference does not resolve: ${reference}`);
  return current;
}

function collectStringFields(
  schema: z.ZodType,
  options: { prefix?: string; opaqueRecordPaths?: ReadonlySet<string> } = {}
): StringFieldInventory {
  const root = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  const rootPath = options.prefix ?? '';
  const stringFields = new Set<string>();
  const followedReferences = new Set<string>();

  const addOpaquePosition = (path: string): void => {
    if (path === '') return;
    stringFields.add(options.opaqueRecordPaths?.has(path) === true ? `${path}.*` : path);
  };

  const walk = (value: unknown, path: string, activeReferences: ReadonlySet<string>): void => {
    if (value === true) {
      addOpaquePosition(path);
      return;
    }
    if (!isRecord(value)) return;

    const reference = value.$ref;
    if (reference !== undefined) {
      if (typeof reference !== 'string')
        throw new Error(`Invalid JSON Schema reference at ${path}`);
      followedReferences.add(path);
      if (activeReferences.has(reference)) return;
      const nextReferences = new Set(activeReferences);
      nextReferences.add(reference);
      walk(
        resolveLocalReference(root, reference),
        reference === '#' ? rootPath : path,
        nextReferences
      );
      return;
    }

    if (Object.keys(value).length === 0) {
      addOpaquePosition(path);
      return;
    }

    const type = value.type;
    if (type === 'string' || (Array.isArray(type) && type.includes('string'))) {
      if (path !== '') stringFields.add(path);
    }

    for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
      const variants = value[keyword];
      if (variants === undefined) continue;
      if (!Array.isArray(variants)) throw new Error(`Invalid JSON Schema ${keyword} at ${path}`);
      for (const variant of variants) walk(variant, path, activeReferences);
    }

    const properties = value.properties;
    if (properties !== undefined) {
      if (!isRecord(properties)) throw new Error(`Invalid JSON Schema properties at ${path}`);
      for (const [name, property] of Object.entries(properties)) {
        walk(property, childPath(path, name), activeReferences);
      }
    }

    const items = value.items;
    if (Array.isArray(items)) {
      for (const item of items) walk(item, childPath(path, '*'), activeReferences);
    } else if (items !== undefined) {
      walk(items, childPath(path, '*'), activeReferences);
    }

    const prefixItems = value.prefixItems;
    if (prefixItems !== undefined) {
      if (!Array.isArray(prefixItems))
        throw new Error(`Invalid JSON Schema prefixItems at ${path}`);
      for (const item of prefixItems) walk(item, childPath(path, '*'), activeReferences);
    }

    const additionalProperties = value.additionalProperties;
    if (additionalProperties !== undefined && additionalProperties !== false) {
      walk(additionalProperties, childPath(path, '*'), activeReferences);
    }
  };

  walk(root, rootPath, new Set());
  return {
    stringFields: [...stringFields].sort(),
    followedReferences: [...followedReferences].sort(),
  };
}

function normalizeRecursiveNodePath(path: string): string {
  const recursivePrefix = 'loop_group.nodes.*.';
  let normalized = path;
  while (normalized.startsWith(recursivePrefix)) {
    normalized = normalized.slice(recursivePrefix.length);
  }
  return normalized === 'with' ? 'with.*' : normalized;
}

function authoredStringFields(schema: z.ZodType): StringFieldInventory {
  // `with` stays opaque in the flat schema because node-mode-specific superRefine logic
  // validates it as an identifier-keyed map. Its authored value position is `with.*`.
  const nodeFields = collectStringFields(schema, { opaqueRecordPaths: new Set(['with']) });
  const bindingFields = collectStringFields(bindingDirectiveSchema, { prefix: 'with.*' });
  return {
    stringFields: [
      ...new Set([
        ...nodeFields.stringFields.map(normalizeRecursiveNodePath),
        ...bindingFields.stringFields,
      ]),
    ].sort(),
    followedReferences: [
      ...new Set([
        ...nodeFields.followedReferences.map(normalizeRecursiveNodePath),
        ...bindingFields.followedReferences,
      ]),
    ].sort(),
  };
}

function completenessProblems(
  schema: z.ZodType,
  classifications: Readonly<
    Record<string, StringFieldClassification>
  > = STRING_FIELD_CLASSIFICATIONS,
  catalogueSlots: ReadonlySet<string> = new Set(Object.keys(SLOT_SPEC)),
  enginePrivateSlots: Readonly<Record<string, string>> = ENGINE_PRIVATE_SLOT_REASONS
): CompletenessProblems {
  const schemaFields = new Set(authoredStringFields(schema).stringFields);
  const classificationFields = new Set(Object.keys(classifications));
  const referencedSlots = new Set<string>();

  for (const classification of Object.values(classifications)) {
    if (classification.kind === 'template') {
      for (const slot of classification.slots) referencedSlots.add(slot);
    }
  }

  return {
    unclassifiedStringFields: [...schemaFields].filter(field => !classificationFields.has(field)),
    classificationsWithoutStringFields: [...classificationFields].filter(
      field => !schemaFields.has(field)
    ),
    templateSlotsMissingFromCatalogue: [...referencedSlots]
      .filter(slot => !catalogueSlots.has(slot))
      .sort(),
    schemaBackedSlotsWithoutClassification: [...catalogueSlots]
      .filter(slot => !referencedSlots.has(slot) && !Object.hasOwn(enginePrivateSlots, slot))
      .sort(),
    enginePrivateSlotsMissingFromCatalogue: Object.keys(enginePrivateSlots)
      .filter(slot => !catalogueSlots.has(slot))
      .sort(),
    literalFieldsWithoutReasons: Object.entries(classifications)
      .filter(([, classification]) => {
        return classification.kind === 'literal' && classification.reason.trim() === '';
      })
      .map(([field]) => field)
      .sort(),
    enginePrivateSlotsWithoutReasons: Object.entries(enginePrivateSlots)
      .filter(([, reason]) => reason.trim() === '')
      .map(([slot]) => slot)
      .sort(),
  };
}

test('the authored string-field classifications and template slot catalogue are complete', () => {
  expect(completenessProblems(dagNodeSchema)).toEqual(EMPTY_COMPLETENESS_PROBLEMS);

  const inventory = authoredStringFields(dagNodeSchema);
  expect(inventory.stringFields).toContain('agents.*.prompt');
  expect(inventory.stringFields).toContain('with.*');
  expect(inventory.stringFields).toContain('with.*.from');
  expect(inventory.followedReferences).toContain('loop_group.nodes.*');
});

test('a new authored string field stays unclassified until its template policy is explicit', () => {
  const mutatedSchema = dagNodeFlatSchema.extend({ future_text: z.string() });

  expect(completenessProblems(mutatedSchema).unclassifiedStringFields).toEqual(['future_text']);

  const literalClassification = {
    ...STRING_FIELD_CLASSIFICATIONS,
    future_text: { kind: 'literal', reason: 'Future text is fixed protocol data' },
  } satisfies Record<string, StringFieldClassification>;
  expect(completenessProblems(mutatedSchema, literalClassification)).toEqual(
    EMPTY_COMPLETENESS_PROBLEMS
  );

  const templateClassification = {
    ...STRING_FIELD_CLASSIFICATIONS,
    future_text: { kind: 'template', slots: ['when'] },
  } satisfies Record<string, StringFieldClassification>;
  expect(completenessProblems(mutatedSchema, templateClassification)).toEqual(
    EMPTY_COMPLETENESS_PROBLEMS
  );
});

test('a classification fails when its template slot leaves the catalogue', () => {
  const incompleteCatalogue = new Set(Object.keys(SLOT_SPEC));
  incompleteCatalogue.delete('when');

  expect(
    completenessProblems(dagNodeSchema, STRING_FIELD_CLASSIFICATIONS, incompleteCatalogue)
      .templateSlotsMissingFromCatalogue
  ).toEqual(['when']);
});

test('workflow and composed fan-out bindings use their classified slot names', () => {
  const workflowNode = {
    id: 'child',
    kind: 'workflow',
    workflow: 'child-workflow',
    with: { topic: '$source.output' },
  } satisfies DagNode;
  const composedFanOutNode = {
    id: 'fan',
    kind: 'compose_fan_out',
    include: 'worker-block',
    with: { topic: '$source.output' },
    fan_out: {
      items: '$source.output',
      as: 'topic',
      max_parallel: 1,
      join: 'all_done',
    },
  } satisfies DagNode;

  const slotIdentity = (node: DagNode): { name: TemplateSlotName; path: string }[] => {
    const slots: { name: TemplateSlotName; path: string }[] = [];
    visitNodeTemplateSlots(node, ({ name, path }) => slots.push({ name, path }));
    return slots;
  };

  expect(slotIdentity(workflowNode)).toContainEqual({
    name: 'workflow.with.*',
    path: 'with.topic',
  });
  expect(slotIdentity(composedFanOutNode)).toContainEqual({
    name: 'compose_fan_out.with.*',
    path: 'with.topic',
  });
});

test('the slot catalogue rejects omitted fixed fields', () => {
  // @ts-expect-error approval.on_reject.prompt must remain catalogued
  const incomplete: Record<TemplateSlotName, { surface: TemplateSurface }> = {
    when: { surface: 'condition' },
    systemPrompt: { surface: 'prompt' },
    'agents.*.prompt': { surface: 'prompt' },
    'agents.*.description': { surface: 'prompt' },
    'agent.prompt': { surface: 'prompt' },
    'binding.value': { surface: 'value' },
    'binding.from': { surface: 'binding_from' },
    'binding.if_skipped': { surface: 'binding_default' },
    'exec.bash': { surface: 'shell' },
    'exec.script': { surface: 'script' },
    'loop.prompt': { surface: 'prompt' },
    'loop.until_bash': { surface: 'shell' },
    'loop.compiled_prompt': { surface: 'prompt' },
    'loop_group.until_bash': { surface: 'shell' },
    'approval.message': { surface: 'prompt' },
    'cancel.reason': { surface: 'prompt' },
    'wait.until': { surface: 'value' },
    'wait.event': { surface: 'value' },
    'wait.attention': { surface: 'prompt' },
    'workflow.input': { surface: 'value' },
    'workflow.with.*': { surface: 'value' },
    'workflow.fan_out.items': { surface: 'value' },
    'compose_fan_out.with.*': { surface: 'value' },
    'compose_fan_out.fan_out.items': { surface: 'value' },
    'composed.inputs.*': { surface: 'value' },
  };
  expect(incomplete['approval.on_reject.prompt']).toBeUndefined();
});

test('walks dynamic template slots without mutating the source node', () => {
  const node = {
    id: 'group',
    kind: 'loop_group',
    systemPrompt: '$setup.output',
    agents: { reviewer: { prompt: '$setup.output', description: '$setup.output' } },
    loop_group: {
      until_bash: 'test $setup.output',
      nodes: [
        {
          id: 'run',
          kind: 'exec',
          runtime: 'bun',
          script: 'console.log($setup.output)',
          with: {
            value: '$setup.output',
            required: { from: '$setup.output', if_skipped: '$setup.output' },
            literal: true,
          },
        },
      ],
    },
  } as unknown as DagNode;

  const slots: string[] = [];
  const bindings: string[] = [];
  visitNodeTemplateSlots(node, slot => slots.push(`${slot.path}:${slot.surface}`), {
    bindingVisitor: binding => bindings.push(`${binding.owner.id}:${binding.path}:${binding.name}`),
  });
  expect(slots).toEqual([
    'systemPrompt:prompt',
    'agents.reviewer.prompt:prompt',
    'agents.reviewer.description:prompt',
    'loop_group.until_bash:shell',
    'loop_group.nodes.0.script:script',
    'loop_group.nodes.0.with.value:value',
    'loop_group.nodes.0.with.required.from:binding_from',
    'loop_group.nodes.0.with.required.if_skipped:binding_default',
  ]);
  expect(bindings).toEqual([
    'run:loop_group.nodes.0.with.value:value',
    'run:loop_group.nodes.0.with.required:required',
    'run:loop_group.nodes.0.with.literal:literal',
  ]);

  const mapped = mapNodeTemplateSlots(node, slot => slot.value.replace('$setup', '$renamed'));
  expect(mapped).not.toBe(node);
  expect(JSON.stringify(node)).toContain('$setup.output');
  expect(JSON.stringify(mapped)).toContain('$renamed.output');
  if (mapped.kind !== 'loop_group') throw new Error('expected loop group');
  expect(mapped.loop_group.nodes[0]).toMatchObject({
    with: { literal: true },
  });

  const values = mapNodeTemplateValueSlots(node, slot =>
    slot.value === '$setup.output' ? { forwarded: true } : slot.value
  );
  if (values.kind !== 'loop_group' || values.loop_group.nodes[0]?.kind !== 'exec')
    throw new Error('expected loop group exec node');
  expect(values.loop_group.nodes[0].with).toMatchObject({
    value: { forwarded: true },
    required: { from: '$setup.output', if_skipped: { forwarded: true } },
    literal: true,
  });
});
