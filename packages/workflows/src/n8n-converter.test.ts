import { describe, it, expect } from 'bun:test';
import { convertN8nToArchon } from './n8n-converter';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const THREE_NODE_FIXTURE = {
  name: 'My Test Workflow',
  nodes: [
    {
      id: 'uuid-1',
      name: 'Fetch Data',
      type: 'n8n-nodes-base.HttpRequest',
      parameters: { url: 'https://api.example.com/data', method: 'GET' },
    },
    {
      id: 'uuid-2',
      name: 'Process Data',
      type: 'n8n-nodes-base.Code',
      parameters: { jsCode: 'console.log(items)', language: 'javaScript' },
    },
    {
      id: 'uuid-3',
      name: 'Unknown Node',
      type: 'n8n-nodes-base.Postgres',
      parameters: {},
    },
  ],
  connections: {
    'Fetch Data': {
      main: [[{ node: 'Process Data', type: 'main', index: 0 }]],
    },
    'Process Data': {
      main: [[{ node: 'Unknown Node', type: 'main', index: 0 }]],
    },
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('convertN8nToArchon', () => {
  it('produces 3 nodes for a 3-node fixture', () => {
    const { workflow } = convertN8nToArchon(THREE_NODE_FIXTURE);
    expect(workflow.nodes).toHaveLength(3);
  });

  it('derives workflow name as kebab-case of n8n name', () => {
    const { workflow } = convertN8nToArchon(THREE_NODE_FIXTURE);
    expect(workflow.name).toBe('my-test-workflow');
  });

  it('sets depends_on from n8n connections', () => {
    const { workflow } = convertN8nToArchon(THREE_NODE_FIXTURE);
    const processNode = workflow.nodes.find(n => n.id === 'process-data');
    expect(processNode?.depends_on).toEqual(['fetch-data']);
    const unknownNode = workflow.nodes.find(n => n.id === 'unknown-node');
    expect(unknownNode?.depends_on).toEqual(['process-data']);
  });

  it('maps HttpRequest to bash node', () => {
    const { workflow } = convertN8nToArchon(THREE_NODE_FIXTURE);
    const node = workflow.nodes.find(n => n.id === 'fetch-data');
    expect(node).toHaveProperty('bash');
    expect((node as { bash: string }).bash).toContain('curl');
    expect((node as { bash: string }).bash).toContain('https://api.example.com/data');
  });

  it('maps Code node (JS) to bash node', () => {
    const { workflow } = convertN8nToArchon(THREE_NODE_FIXTURE);
    const node = workflow.nodes.find(n => n.id === 'process-data');
    expect(node).toHaveProperty('bash');
  });

  it('adds a warning for unknown node type', () => {
    const { warnings } = convertN8nToArchon(THREE_NODE_FIXTURE);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('n8n-nodes-base.Postgres');
    expect(warnings[0]).toContain('Unknown Node');
  });

  it('converts unknown node to bash stub with TODO comment', () => {
    const { workflow } = convertN8nToArchon(THREE_NODE_FIXTURE);
    const node = workflow.nodes.find(n => n.id === 'unknown-node') as { bash?: string } | undefined;
    expect(node?.bash).toContain('TODO');
    expect(node?.bash).toContain('n8n-nodes-base.Postgres');
  });

  it('maps Wait node to approval node', () => {
    const fixture = {
      name: 'wait-workflow',
      nodes: [{ id: 'w1', name: 'Pause', type: 'n8n-nodes-base.Wait', parameters: {} }],
      connections: {},
    };
    const { workflow } = convertN8nToArchon(fixture);
    const node = workflow.nodes[0] as { approval?: { message: string } };
    expect(node?.approval?.message).toContain('paused');
  });

  it('maps OpenAiChat node to prompt node', () => {
    const fixture = {
      name: 'ai-workflow',
      nodes: [
        {
          id: 'a1',
          name: 'Ask AI',
          type: 'n8n-nodes-base.OpenAiChat',
          parameters: { prompt: 'Summarize the data' },
        },
      ],
      connections: {},
    };
    const { workflow } = convertN8nToArchon(fixture);
    const node = workflow.nodes[0] as { prompt?: string };
    expect(node.prompt).toBe('Summarize the data');
  });

  it('maps Code node with Python to script node with uv runtime', () => {
    const fixture = {
      name: 'py-workflow',
      nodes: [
        {
          id: 'p1',
          name: 'Run Python',
          type: 'n8n-nodes-base.Code',
          parameters: { pythonCode: 'print("hello")', language: 'python' },
        },
      ],
      connections: {},
    };
    const { workflow } = convertN8nToArchon(fixture);
    const node = workflow.nodes[0] as { script?: string; runtime?: string };
    expect(node.script).toContain('print("hello")');
    expect(node.runtime).toBe('uv');
  });

  it('returns warning and empty workflow for non-object input', () => {
    const { workflow, warnings } = convertN8nToArchon('not an object');
    expect(workflow.nodes).toHaveLength(0);
    expect(warnings[0]).toContain('not a valid n8n workflow object');
  });

  it('deduplicates node IDs when two nodes kebab-case to the same string', () => {
    const fixture = {
      name: 'dup',
      nodes: [
        { id: 'x1', name: 'My Node', type: 'n8n-nodes-base.Code', parameters: { jsCode: 'a' } },
        { id: 'x2', name: 'My Node', type: 'n8n-nodes-base.Code', parameters: { jsCode: 'b' } },
      ],
      connections: {},
    };
    const { workflow } = convertN8nToArchon(fixture);
    const ids = workflow.nodes.map(n => n.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain('my-node');
    expect(ids).toContain('my-node-1');
  });
});
