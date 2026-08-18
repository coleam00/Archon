import { describe, expect, test } from 'bun:test';
import { formatToolCall, formatThinking } from './tool-formatter';

describe('tool-formatter', () => {
  describe('formatToolCall', () => {
    describe('Bash tool', () => {
      test('formats short command', () => {
        const result = formatToolCall('Bash', { command: 'npm test' });
        expect(result).toBe('🔧 BASH\nnpm test');
      });

      test('truncates long command at 100 chars', () => {
        const longCommand = 'a'.repeat(120);
        const result = formatToolCall('Bash', { command: longCommand });
        expect(result).toBe(`🔧 BASH\n${'a'.repeat(100)}...`);
      });

      test('shows exactly 100 chars without truncation', () => {
        const exactCommand = 'a'.repeat(100);
        const result = formatToolCall('Bash', { command: exactCommand });
        expect(result).toBe(`🔧 BASH\n${exactCommand}`);
      });
    });

    describe('Read tool', () => {
      test('formats file path', () => {
        const result = formatToolCall('Read', { file_path: '/path/to/file.ts' });
        expect(result).toBe('🔧 READ\nReading: /path/to/file.ts');
      });
    });

    describe('Write tool', () => {
      test('formats file path', () => {
        const result = formatToolCall('Write', { file_path: '/path/to/file.ts' });
        expect(result).toBe('🔧 WRITE\nWriting: /path/to/file.ts');
      });
    });

    describe('Edit tool', () => {
      test('formats file path', () => {
        const result = formatToolCall('Edit', { file_path: '/path/to/file.ts' });
        expect(result).toBe('🔧 EDIT\nEditing: /path/to/file.ts');
      });
    });

    describe('Glob tool', () => {
      test('formats pattern', () => {
        const result = formatToolCall('Glob', { pattern: '**/*.ts' });
        expect(result).toBe('🔧 GLOB\nPattern: **/*.ts');
      });
    });

    describe('Grep tool', () => {
      test('formats pattern', () => {
        const result = formatToolCall('Grep', { pattern: 'TODO' });
        expect(result).toBe('🔧 GREP\nSearching: TODO');
      });
    });

    describe('MCP tools', () => {
      test('formats mcp__server__tool pattern', () => {
        const result = formatToolCall('mcp__github__create_issue', { title: 'test' });
        expect(result).toBe('🔧 MCP__GITHUB__CREATE_ISSUE\nMCP: github create_issue');
      });

      test('formats mcp with two parts', () => {
        const result = formatToolCall('mcp__tool', { arg: 'value' });
        expect(result).toBe('🔧 MCP__TOOL\nMCP: tool');
      });
    });

    describe('unknown tools', () => {
      test('shows JSON input for unknown tool', () => {
        const result = formatToolCall('CustomTool', { arg: 'value' });
        expect(result).toBe('🔧 CUSTOMTOOL\n{"arg":"value"}');
      });

      test('truncates long JSON input at 80 chars', () => {
        const longValue = 'x'.repeat(100);
        const result = formatToolCall('CustomTool', { arg: longValue });
        const expectedJson = JSON.stringify({ arg: longValue });
        expect(result).toBe(`🔧 CUSTOMTOOL\n${expectedJson.substring(0, 80)}...`);
      });
    });

    describe('no toolInput', () => {
      test('returns tool name only when toolInput is undefined', () => {
        const result = formatToolCall('SomeTool');
        expect(result).toBe('🔧 SOMETOOL');
      });

      test('returns tool name only when toolInput is null', () => {
        const result = formatToolCall('SomeTool', undefined);
        expect(result).toBe('🔧 SOMETOOL');
      });
    });

    describe('empty toolInput', () => {
      test('returns JSON for empty object', () => {
        const result = formatToolCall('SomeTool', {});
        expect(result).toBe('🔧 SOMETOOL\n{}');
      });
    });
  });

  describe('formatThinking', () => {
    test('formats thinking under 200 chars', () => {
      const thinking = 'I need to analyze this code';
      const result = formatThinking(thinking);
      expect(result).toBe(`💭 ${thinking}`);
    });

    test('formats thinking at exactly 200 chars', () => {
      const thinking = 'a'.repeat(200);
      const result = formatThinking(thinking);
      expect(result).toBe(`💭 ${thinking}`);
    });

    test('truncates thinking over 200 chars', () => {
      const thinking = 'a'.repeat(250);
      const result = formatThinking(thinking);
      expect(result).toBe(`💭 ${'a'.repeat(200)}...`);
    });

    test('handles empty string', () => {
      const result = formatThinking('');
      expect(result).toBe('💭 ');
    });
  });
});
