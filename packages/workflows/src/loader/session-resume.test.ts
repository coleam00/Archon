// @archon-test-isolated
import {
  discoverFiles,
  parseError,
  parseWorkflow,
  parseWorkflowYaml,
  useTempWorkflowRoot,
} from './test-utils';
import { clearRegistry, registerProvider } from '@archon/providers';
import { registerBuiltinProviders, registerCommunityProviders } from '@archon/providers/in-process';
import type { ProviderCapabilities, ProviderDefaults } from '@archon/provider-contract';
import { describe, it, expect } from 'bun:test';
import { isLoopGroupNode, type DagNode } from '../schemas';
import type { ParseResult } from '../loader';

/** Restore the built-in registry after a test registers extra providers. */
function withRegistry(register: () => void, run: () => void): void {
  register();
  try {
    run();
  } finally {
    clearRegistry();
    registerBuiltinProviders();
  }
}

/** Register a provider that supports nothing, `sessionResume` included. */
function registerNoResumeProvider(id: string): void {
  const capabilities: ProviderCapabilities = {
    backgroundWork: 'unobserved',
    sessionResume: false,
    mcp: false,
    hooks: false,
    skills: false,
    plugins: false,
    agents: false,
    toolRestrictions: false,
    structuredOutput: false,
    envInjection: false,
    costControl: false,
    costReporting: false,
    effortControl: false,
    fallbackModel: false,
    sandbox: false,
    settingSources: false,
    nativeTools: false,
    containerExec: false,
    requiresAllPropertiesRequired: false,
  };
  registerProvider({
    id,
    displayName: id,
    builtIn: false,
    credentials: { kind: 'static', specs: [], vendorFor: () => undefined },
    parseConfig: (raw: ProviderDefaults): ProviderDefaults => raw,
    capabilities,
    factory: () => ({
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => id,
      getCapabilities: () => capabilities,
      async *sendQuery() {
        return;
      },
    }),
  });
}

describe('addressable session resume', () => {
  function parseAddressable(yaml: string): ParseResult {
    return parseWorkflow(yaml, 'addressable.yaml');
  }

  it('accepts transitively upstream command, prompt, and plain loop sources', () => {
    const result = parseAddressable(`
name: addressable
description: addressable sessions
provider: claude
nodes:
  - id: command-source
    command: scope
  - id: prompt-source
    prompt: review
    depends_on: [command-source]
  - id: loop-source
    loop:
      prompt: refine
      until: DONE
      max_iterations: 2
    depends_on: [prompt-source]
  - id: consumer
    prompt: synthesize
    depends_on: [loop-source]
    context:
      resume: command-source
`);
    expect(result.error).toBeNull();
    expect((result.workflow?.nodes as DagNode[] | undefined)?.at(-1)?.context).toEqual({
      resume: 'command-source',
    });
  });

  for (const [label, sourceNode] of [
    ['bash', '  - id: source\n    bash: echo scope'],
    ['script', '  - id: source\n    script: console.log(1)\n    runtime: bun'],
    ['approval', "  - id: source\n    approval:\n      message: 'Approve?'"],
    ['workflow', '  - id: source\n    workflow: child'],
  ] as const) {
    it(`rejects a ${label} source`, () => {
      const result = parseAddressable(`
name: bad-source
description: bad source
provider: claude
nodes:
${sourceNode}
  - id: consumer
    prompt: continue
    depends_on: [source]
    context: { resume: source }
`);
      expect(result.error?.error).toContain('not a session-producing command, prompt, or loop');
    });
  }

  it('rejects missing, self, downstream, and sibling sources', () => {
    const missing = parseAddressable(`
name: missing
description: missing
nodes:
  - id: consumer
    prompt: continue
    context: { resume: ghost }
`);
    expect(missing.error?.error).toContain("references unknown node 'ghost'");

    const self = parseAddressable(`
name: self
description: self
nodes:
  - id: consumer
    prompt: continue
    context: { resume: consumer }
`);
    expect(self.error?.error).toContain('not an upstream dependency');

    const downstream = parseAddressable(`
name: downstream
description: downstream
nodes:
  - id: consumer
    prompt: continue
    context: { resume: later }
  - id: later
    prompt: later
    depends_on: [consumer]
`);
    expect(downstream.error?.error).toContain('not an upstream dependency');

    const sibling = parseAddressable(`
name: sibling
description: sibling
nodes:
  - id: source
    prompt: source
  - id: consumer
    prompt: continue
    context: { resume: source }
`);
    expect(sibling.error?.error).toContain('not an upstream dependency');
  });

  it('accepts a named pre-loop owner and rejects unordered and non-session sources', () => {
    const workflow = (source: string, dependencies = '[source]') => `
name: owners
description: owners
nodes:
  - id: source
    ${source}
  - id: corrections
    depends_on: ${dependencies}
    loop_group:
      until_bash: 'test $review.output.done = true'
      max_iterations: 3
      nodes:
        - id: owner
          prompt: correct
          context: { resume: source }
        - id: review
          prompt: review
          context: fresh
          depends_on: [owner]
          output_format:
            type: object
            properties:
              done: { type: boolean }
            required: [done]
`;
    expect(parseAddressable(workflow('prompt: implement')).error).toBeNull();
    expect(parseAddressable(workflow('command: implement')).error).toBeNull();
    expect(parseAddressable(workflow('prompt: implement', '[]')).error?.error).toContain(
      'upstream dependency'
    );
    expect(parseAddressable(workflow('bash: echo ready')).error?.error).toContain(
      'not a session-producing'
    );
    expect(
      parseAddressable(
        workflow('prompt: implement\n    provider: claude').replace(
          'prompt: correct',
          'prompt: correct\n          provider: codex'
        )
      ).error?.error
    ).toContain("consumer uses 'codex'");
  });

  it('proves nested ancestry at each enclosing group entry with provider defaults', () => {
    const yaml = `
name: nested-owner
description: nested owner
provider: claude
nodes:
  - id: source
    loop: { prompt: implement, until: DONE, max_iterations: 1 }
  - id: outer
    depends_on: [source]
    loop_group:
      until_bash: exit 0
      max_iterations: 2
      nodes:
        - id: local
          prompt: local
        - id: inner
          depends_on: [local]
          loop_group:
            until_bash: exit 0
            max_iterations: 2
            nodes:
              - id: owner
                prompt: owner
                context: { resume: local }
              - id: ancestor-owner
                prompt: owner
                context: { resume: source }
`;
    expect(parseAddressable(yaml).error).toBeNull();
    expect(
      parseAddressable(yaml.replace('depends_on: [local]', 'depends_on: []')).error?.error
    ).toContain('upstream dependency');
    expect(
      parseAddressable(yaml.replace('depends_on: [source]', 'depends_on: []')).error?.error
    ).toContain('upstream dependency');
    expect(
      parseAddressable(yaml.replace('id: outer', 'id: outer\n    provider: codex')).error?.error
    ).toContain("consumer uses 'codex'");
  });

  it('accepts an upstream same-body source and rejects other same-body and cross-body shapes', () => {
    const withConsumer = (consumer: string, siblingGroup = '') =>
      parseAddressable(`
name: same-body
description: same-body
nodes:
  - id: group
    loop_group:
      until: DONE
      max_iterations: 2
      nodes:
        - id: source
          prompt: source
        - id: other
          prompt: other
        - id: consumer
${consumer}
${siblingGroup}`);

    expect(
      withConsumer(`          prompt: continue
          depends_on: [source]
          context: { resume: source }`).error
    ).toBeNull();
    expect(
      withConsumer(`          prompt: continue
          depends_on: [other]
          context: { resume: source }`).error?.error
    ).toContain("source 'source' is not an upstream dependency");
    expect(
      withConsumer(
        `          prompt: continue
          context: { resume: elsewhere }`,
        `  - id: sibling
    loop_group:
      until: DONE
      max_iterations: 2
      nodes:
        - id: elsewhere
          prompt: elsewhere`
      ).error?.error
    ).toContain("references unknown node 'elsewhere'");
    expect(
      withConsumer(`          bash: echo hi
          depends_on: [source]
          context: { resume: source }`).error?.error
    ).toContain("'context.resume' is only supported on command and prompt nodes");
  });

  it('rejects statically mismatched and fork-incapable providers', () => {
    const mismatch = parseAddressable(`
name: mismatch
description: mismatch
nodes:
  - id: source
    prompt: source
    provider: claude
  - id: consumer
    prompt: continue
    provider: codex
    depends_on: [source]
    context: { resume: source }
`);
    expect(mismatch.error?.error).toContain("source 'source' uses provider 'claude'");
    expect(mismatch.error?.error).toContain("consumer uses 'codex'");

    withRegistry(registerCommunityProviders, () => {
      const incapable = parseAddressable(`
name: incapable
description: incapable
provider: copilot
nodes:
  - id: source
    prompt: source
  - id: consumer
    prompt: continue
    depends_on: [source]
    context: { resume: source }
`);
      expect(incapable.error?.error).toContain("provider 'copilot' does not support sessionFork");
    });
  });

  it('defers implicit provider resolution to runtime', () => {
    const result = parseAddressable(`
name: implicit
description: implicit
nodes:
  - id: source
    prompt: source
  - id: consumer
    prompt: continue
    depends_on: [source]
    context: { resume: source }
`);
    expect(result.error).toBeNull();
  });
});

describe('persist_session capability gating', () => {
  it('parses persist_session: true on a node', () => {
    const { workflow } = parseWorkflowYaml(
      `name: t\ndescription: t\nprovider: claude\nnodes:\n  - id: planner\n    prompt: p\n    persist_session: true\n`
    );
    const node = workflow.nodes[0];
    expect('persist_session' in node ? node.persist_session : undefined).toBe(true);
  });

  it('does NOT capability-check non-AI nodes when persist_sessions is workflow-level', () => {
    // Regression for CodeRabbit #7: workflow-level persist_sessions: true with a bash
    // node would falsely trigger the capability check on a provider that can't even
    // be invoked from a bash node. Bash/script/approval/cancel/loop and context:'fresh'
    // nodes must skip the capability gate.
    withRegistry(
      () => registerNoResumeProvider('no-resume-skip-test'),
      () => {
        // Workflow opts in at root; the only node is bash. Should LOAD CLEAN because
        // bash never invokes a provider session.
        parseWorkflowYaml(
          `name: t\ndescription: t\nprovider: no-resume-skip-test\npersist_sessions: true\nnodes:\n  - id: build\n    bash: 'echo hello'\n`
        );
      }
    );
  });

  it('warns, and still loads, when the provider cannot fork the persisted session', () => {
    withRegistry(registerCommunityProviders, () => {
      const copilot = parseWorkflow(
        `name: t\ndescription: t\nprovider: copilot\npersist_sessions: true\nnodes:\n  - id: planner\n    prompt: p\n`,
        't.yaml'
      );
      expect(copilot.error).toBeNull();
      expect(copilot.warnings?.filter(w => w.includes('cannot fork a session'))).toEqual([
        expect.stringContaining("Node 'planner'"),
      ]);
    });

    const claude = parseWorkflow(
      `name: t\ndescription: t\nprovider: claude\npersist_sessions: true\nnodes:\n  - id: planner\n    prompt: p\n`,
      't.yaml'
    );
    expect(claude.warnings?.some(w => w.includes('cannot fork a session'))).toBe(false);
  });

  it('rejects persist_session: true on a provider without sessionResume', () => {
    withRegistry(
      () => registerNoResumeProvider('no-resume-test'),
      () => {
        const error = parseError(
          `name: t\ndescription: t\nprovider: no-resume-test\nnodes:\n  - id: planner\n    prompt: p\n    persist_session: true\n`
        );
        expect(error).toContain('persist_session');
        expect(error).toContain('sessionResume');
      }
    );
  });

  describe('collapse onto nodes during composition', () => {
    const root = useTempWorkflowRoot();

    it('collapses persist_sessions onto AI nodes only, so composition preserves it', async () => {
      // The workflow-level default is what the executor's `nodeUsesPersistedScope`
      // reads for a node with no `persist_session:` of its own. Once composition
      // removes the workflow-level layer (#1764) the default has to have landed on
      // the nodes that can use it — and NOT on the ones that cannot, or the loader's
      // capability gate and the executor's predicate disagree about the same file.
      const result = await discoverFiles(root(), {
        'persist.yaml': `name: persist-collapse\ndescription: t\nprovider: claude\npersist_sessions: true\nnodes:\n  - id: planner\n    prompt: p\n  - id: shell\n    bash: echo hi\n`,
      });
      expect(result.errors).toEqual([]);
      const expanded = result.workflows[0].workflow;
      expect(expanded.persist_sessions).toBeUndefined();
      const byId = new Map((expanded.nodes as DagNode[]).map(n => [n.id, n]));
      expect(byId.get('planner')?.persist_session).toBe(true);
      expect(byId.get('shell')?.persist_session).toBeUndefined();
    });

    it('does NOT collapse persist_sessions into a loop_group body', async () => {
      // A body runs in a context the executor builds with `workflowPersistSessions: false`,
      // so the workflow-level default has never reached it. `nodeUsesPersistedScope` reads
      // the NODE value first, so pushing it here would override that deliberate false and
      // grant a body cross-run persistence it never had — and could trip the runtime
      // sessionResume guard on a provider that lacks it.
      const result = await discoverFiles(root(), {
        'lg-persist.yaml': `name: lg-persist\ndescription: t\nprovider: claude\npersist_sessions: true\nnodes:\n  - id: group\n    loop_group:\n      until: DONE\n      max_iterations: 2\n      nodes:\n        - id: body\n          prompt: p\n  - id: after\n    prompt: p\n`,
      });
      expect(result.errors).toEqual([]);
      const nodes = result.workflows[0].workflow.nodes as DagNode[];
      const group = nodes.find(n => n.id === 'group');
      expect(group && isLoopGroupNode(group)).toBe(true);
      const body = group && isLoopGroupNode(group) ? group.loop_group.nodes[0] : undefined;
      expect(body).toBeDefined();
      expect((body as DagNode | undefined)?.persist_session).toBeUndefined();
      // The top-level AI node still receives it — only the body is excluded.
      expect(nodes.find(n => n.id === 'after')?.persist_session).toBe(true);
    });
  });
});
