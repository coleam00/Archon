import { describe, expect, test } from 'bun:test';

import { parseQoderCliConfig } from './config';

describe('parseQoderCliConfig', () => {
  test('returns empty object for empty input', () => {
    expect(parseQoderCliConfig({})).toEqual({});
  });

  test('parses model', () => {
    expect(parseQoderCliConfig({ model: 'qoder-pro' })).toEqual({ model: 'qoder-pro' });
  });

  test('trims string fields', () => {
    expect(parseQoderCliConfig({ model: ' qoder-pro ' })).toEqual({ model: 'qoder-pro' });
  });

  test('rejects non-string model', () => {
    expect(() => parseQoderCliConfig({ model: 123 })).toThrow('assistants.qodercli.model');
  });

  test('rejects blank string fields', () => {
    expect(() => parseQoderCliConfig({ model: '   ' })).toThrow('non-empty string');
  });

  test('parses valid reasoning efforts', () => {
    for (const value of ['low', 'medium', 'high', 'max'] as const) {
      expect(parseQoderCliConfig({ modelReasoningEffort: value })).toEqual({
        modelReasoningEffort: value,
      });
    }
  });

  test('rejects unknown reasoning efforts', () => {
    expect(() => parseQoderCliConfig({ modelReasoningEffort: 'xhigh' })).toThrow(
      'modelReasoningEffort'
    );
    expect(() => parseQoderCliConfig({ modelReasoningEffort: 'minimal' })).toThrow(
      'modelReasoningEffort'
    );
  });

  test('parses binary and config paths', () => {
    expect(
      parseQoderCliConfig({
        qodercliBinaryPath: '/bin/qodercli',
        configDir: '/tmp/qoder',
      })
    ).toEqual({
      qodercliBinaryPath: '/bin/qodercli',
      configDir: '/tmp/qoder',
    });
  });

  test('parses permission mode values', () => {
    for (const value of [
      'default',
      'accept_edits',
      'bypass_permissions',
      'dont_ask',
      'auto',
    ] as const) {
      expect(parseQoderCliConfig({ permissionMode: value })).toEqual({ permissionMode: value });
    }
  });

  test('rejects invalid permission mode', () => {
    expect(() => parseQoderCliConfig({ permissionMode: 'sudo' })).toThrow('permissionMode');
  });

  test('parses output format and MCP config', () => {
    expect(parseQoderCliConfig({ outputFormat: 'text', mcpConfig: '{"mcpServers":{}}' })).toEqual({
      outputFormat: 'text',
      mcpConfig: '{"mcpServers":{}}',
    });
  });

  test('rejects invalid setting sources', () => {
    expect(() => parseQoderCliConfig({ settingSources: ['user', 'bad', 'project'] })).toThrow(
      'settingSources'
    );
  });

  test('drops empty setting source result', () => {
    expect(parseQoderCliConfig({ settingSources: [] })).toEqual({});
  });

  test('combines all supported fields', () => {
    expect(
      parseQoderCliConfig({
        model: 'qoder-pro',
        modelReasoningEffort: 'high',
        qodercliBinaryPath: '/bin/qodercli',
        configDir: '/tmp/qoder',
        permissionMode: 'bypass_permissions',
        outputFormat: 'text',
        settingSources: ['user', 'project'],
        mcpConfig: 'mcp.json',
      })
    ).toEqual({
      model: 'qoder-pro',
      modelReasoningEffort: 'high',
      qodercliBinaryPath: '/bin/qodercli',
      configDir: '/tmp/qoder',
      permissionMode: 'bypass_permissions',
      outputFormat: 'text',
      settingSources: ['user', 'project'],
      mcpConfig: 'mcp.json',
    });
  });
});
