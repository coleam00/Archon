// @archon-test-isolated
import { describe, expect, test } from 'bun:test';
import { parseWorkflowYaml } from './loader/test-utils';
import {
  assertTrustedTextProviderSupported,
  assertTrustedTextWorkflowSupported,
  inheritedTrustedTextMetadata,
} from './trusted-text';
import type { DagNode } from './schemas';

function workflow(node: string, webSearchMode = 'disabled') {
  const parsed = parseWorkflowYaml(`name: trust
description: trust test
webSearchMode: ${webSearchMode}
nodes:
${node}`).workflow;
  return { ...parsed, nodes: parsed.nodes as DagNode[] };
}

describe('trusted text protected-mode boundary', () => {
  test('propagates the accepted snapshot to child run metadata', () => {
    const snapshot = { schemaVersion: 1, title: 'Accepted' };
    expect(inheritedTrustedTextMetadata({ trusted_text: snapshot })).toEqual({
      trusted_text: snapshot,
    });
    expect(inheritedTrustedTextMetadata({})).toEqual({});
  });

  test('accepts only read-only agent nodes', () => {
    const value = workflow(`  - id: read
    prompt: Read the accepted item
    allowed_tools: [Read, Grep, Glob]`);
    expect(() => assertTrustedTextWorkflowSupported(value)).not.toThrow();
  });

  test.each([
    ['ambient tools', '    prompt: Read'],
    ['shell', '    prompt: Read\n    allowed_tools: [Read, Bash]'],
    ['MCP', '    prompt: Read\n    allowed_tools: [Read]\n    mcp: .archon/mcp.json'],
    ['plugins', '    prompt: Read\n    allowed_tools: [Read]\n    plugins: [remote@marketplace]'],
    ['hooks', '    prompt: Read\n    allowed_tools: [Read]\n    hooks:\n      PreToolUse: []'],
    ['skills', '    prompt: Read\n    allowed_tools: [Read]\n    skills: [remote-reader]'],
    [
      'inline agents',
      '    prompt: Read\n    allowed_tools: [Read]\n    agents:\n      other:\n        description: Other\n        prompt: Other',
    ],
  ])('refuses %s before any provider starts', (_name, body) => {
    expect(() => assertTrustedTextWorkflowSupported(workflow(`  - id: read\n${body}`))).toThrow(
      'trusted_text_'
    );
  });

  test('requires an effective provider tool restriction instead of trusting the authored list', () => {
    expect(() => assertTrustedTextProviderSupported({ toolRestrictions: false }, 'codex')).toThrow(
      'trusted_text_provider_cannot_restrict_tools'
    );
    expect(() =>
      assertTrustedTextProviderSupported({ toolRestrictions: true }, 'claude')
    ).not.toThrow();
    expect(() => assertTrustedTextProviderSupported({ toolRestrictions: true }, 'pi')).toThrow(
      'trusted_text_provider_cannot_restrict_tools'
    );
  });

  test('refuses live web access and executable nodes', () => {
    expect(() =>
      assertTrustedTextWorkflowSupported(
        workflow('  - id: read\n    prompt: Read\n    allowed_tools: [Read]', 'live')
      )
    ).toThrow('trusted_text_web_bypass');
    expect(() =>
      assertTrustedTextWorkflowSupported(workflow('  - id: shell\n    bash: echo no'))
    ).toThrow('trusted_text_unsupported_node');
  });
});
