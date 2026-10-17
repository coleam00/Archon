import { describe, expect, test } from 'bun:test';
import { LEGACY_TOOL_NAME_ALIASES } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_CAPABILITIES } from './capabilities';

describe('CLAUDE_CAPABILITIES.renamedTools', () => {
  test("matches the installed SDK's legacy tool-name aliases", () => {
    expect(CLAUDE_CAPABILITIES.renamedTools).toEqual(LEGACY_TOOL_NAME_ALIASES);
  });
});
