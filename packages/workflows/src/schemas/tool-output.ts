import type { DagNode } from './dag-node';

export function nodeOutputSchema(node: DagNode): Record<string, unknown> | undefined {
  if (node.kind !== 'agent' || !node.tools) return node.output_format;
  const schema = node.output_format;
  const calls = { type: 'array', items: { type: 'object', additionalProperties: true } };
  return schema?.type === 'object'
    ? {
        ...schema,
        properties: { ...Object(schema.properties), tool_calls: calls },
        required: [...(Array.isArray(schema.required) ? schema.required : []), 'tool_calls'],
      }
    : {
        type: 'object',
        properties: { result: schema ?? {}, tool_calls: calls },
        required: ['result', 'tool_calls'],
      };
}
