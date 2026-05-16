import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadAgentRegistry,
  loadAgentFile,
  resolveAgent,
  parseFrontmatter,
  AgentRegistryError,
} from './registry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `agent-registry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  try {
    await rm(testDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

async function writeAgent(filename: string, content: string): Promise<string> {
  const filePath = join(testDir, filename);
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

const VALID_AGENT = `---
name: test-agent
model: sonnet
tools: [Read, Grep]
description: A test agent.
---

You are a test agent. You test things.
`;

// ---------------------------------------------------------------------------
// parseFrontmatter
// ---------------------------------------------------------------------------

describe('parseFrontmatter', () => {
  test('parses simple frontmatter', () => {
    const result = parseFrontmatter('---\nname: my-agent\nmodel: sonnet\n---\n\nBody here.');
    expect(result).not.toBeNull();
    expect(result?.frontmatter.name).toBe('my-agent');
    expect(result?.frontmatter.model).toBe('sonnet');
    expect(result?.body).toBe('Body here.');
  });

  test('parses inline array tools', () => {
    const result = parseFrontmatter('---\nname: a\nmodel: opus\ntools: [Read, Grep, Glob]\n---\n\nPrompt.');
    expect(result?.frontmatter.tools).toEqual(['Read', 'Grep', 'Glob']);
  });

  test('parses block sequence tools', () => {
    const content = `---
name: a
model: sonnet
tools:
  - Read
  - Grep
---

Prompt.`;
    const result = parseFrontmatter(content);
    expect(result?.frontmatter.tools).toEqual(['Read', 'Grep']);
  });

  test('returns null when no opening ---', () => {
    const result = parseFrontmatter('name: foo\n\nBody.');
    expect(result).toBeNull();
  });

  test('returns null when closing --- is missing', () => {
    const result = parseFrontmatter('---\nname: foo\n\nBody.');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// loadAgentFile — happy path
// ---------------------------------------------------------------------------

describe('loadAgentFile happy path', () => {
  test('loads a valid agent file', async () => {
    const filePath = await writeAgent('test-agent.md', VALID_AGENT);
    const persona = await loadAgentFile(filePath);
    expect(persona.name).toBe('test-agent');
    expect(persona.model).toBe('sonnet');
    expect(persona.tools).toEqual(['Read', 'Grep']);
    expect(persona.systemPrompt).toContain('You are a test agent');
  });

  test('tools field is optional', async () => {
    const content = `---
name: no-tools-agent
model: opus
---

System prompt here.
`;
    const filePath = await writeAgent('no-tools-agent.md', content);
    const persona = await loadAgentFile(filePath);
    expect(persona.tools).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// loadAgentFile — error codes (fail-closed)
// ---------------------------------------------------------------------------

describe('loadAgentFile error codes', () => {
  test('agent_missing_name: frontmatter has no name field', async () => {
    const content = `---
model: sonnet
---

Prompt.
`;
    const filePath = await writeAgent('missing-name.md', content);
    let err: AgentRegistryError | null = null;
    try {
      await loadAgentFile(filePath);
    } catch (e) {
      err = e as AgentRegistryError;
    }
    expect(err).not.toBeNull();
    expect(err?.code).toBe('agent_missing_name');
  });

  test('agent_name_filename_mismatch: frontmatter name does not match filename', async () => {
    const content = `---
name: different-name
model: sonnet
---

Prompt.
`;
    const filePath = await writeAgent('actual-name.md', content);
    let err: AgentRegistryError | null = null;
    try {
      await loadAgentFile(filePath);
    } catch (e) {
      err = e as AgentRegistryError;
    }
    expect(err).not.toBeNull();
    expect(err?.code).toBe('agent_name_filename_mismatch');
  });

  test('agent_missing_model: frontmatter has no model field', async () => {
    const content = `---
name: no-model
---

Prompt.
`;
    const filePath = await writeAgent('no-model.md', content);
    let err: AgentRegistryError | null = null;
    try {
      await loadAgentFile(filePath);
    } catch (e) {
      err = e as AgentRegistryError;
    }
    expect(err).not.toBeNull();
    expect(err?.code).toBe('agent_missing_model');
  });

  test('agent_invalid_model: model alias not in known set', async () => {
    const content = `---
name: bad-model
model: gpt-4o
---

Prompt.
`;
    const filePath = await writeAgent('bad-model.md', content);
    let err: AgentRegistryError | null = null;
    try {
      await loadAgentFile(filePath);
    } catch (e) {
      err = e as AgentRegistryError;
    }
    expect(err).not.toBeNull();
    expect(err?.code).toBe('agent_invalid_model');
  });

  test('agent_invalid_tool: tool not in known allowlist', async () => {
    const content = `---
name: bad-tool
model: sonnet
tools: [Read, FakeTool]
---

Prompt.
`;
    const filePath = await writeAgent('bad-tool.md', content);
    let err: AgentRegistryError | null = null;
    try {
      await loadAgentFile(filePath);
    } catch (e) {
      err = e as AgentRegistryError;
    }
    expect(err).not.toBeNull();
    expect(err?.code).toBe('agent_invalid_tool');
  });

  test('agent_empty_prompt: body is empty after frontmatter', async () => {
    const content = `---
name: empty-prompt
model: sonnet
---
`;
    const filePath = await writeAgent('empty-prompt.md', content);
    let err: AgentRegistryError | null = null;
    try {
      await loadAgentFile(filePath);
    } catch (e) {
      err = e as AgentRegistryError;
    }
    expect(err).not.toBeNull();
    expect(err?.code).toBe('agent_empty_prompt');
  });

  test('agent_missing_name: file without frontmatter markers', async () => {
    const content = `Just a plain markdown file with no frontmatter.`;
    const filePath = await writeAgent('no-frontmatter.md', content);
    let err: AgentRegistryError | null = null;
    try {
      await loadAgentFile(filePath);
    } catch (e) {
      err = e as AgentRegistryError;
    }
    expect(err).not.toBeNull();
    expect(err?.code).toBe('agent_missing_name');
  });
});

// ---------------------------------------------------------------------------
// loadAgentRegistry
// ---------------------------------------------------------------------------

describe('loadAgentRegistry', () => {
  test('loads all valid agents from directory', async () => {
    const agent1 = `---\nname: agent-one\nmodel: sonnet\n---\n\nAgent one prompt.`;
    const agent2 = `---\nname: agent-two\nmodel: opus\n---\n\nAgent two prompt.`;
    await writeAgent('agent-one.md', agent1);
    await writeAgent('agent-two.md', agent2);

    const registry = await loadAgentRegistry(testDir);
    expect(registry.size).toBe(2);
    expect(registry.has('agent-one')).toBe(true);
    expect(registry.has('agent-two')).toBe(true);
  });

  test('returns empty registry when directory does not exist', async () => {
    const registry = await loadAgentRegistry(join(testDir, 'nonexistent'));
    expect(registry.size).toBe(0);
  });

  test('throws on first invalid file (fail-closed)', async () => {
    await writeAgent('valid-agent.md', VALID_AGENT.replace('test-agent', 'valid-agent'));
    await writeAgent('bad-agent.md', '---\nname: bad-agent\n---\n\nMissing model.');

    let err: AgentRegistryError | null = null;
    try {
      await loadAgentRegistry(testDir);
    } catch (e) {
      err = e as AgentRegistryError;
    }
    expect(err).not.toBeNull();
    expect(err?.code).toBe('agent_missing_model');
  });

  test('ignores non-.md files in directory', async () => {
    await writeAgent('valid-agent.md', VALID_AGENT.replace('test-agent', 'valid-agent'));
    await writeFile(join(testDir, 'readme.txt'), 'not an agent', 'utf-8');
    await writeFile(join(testDir, '.gitkeep'), '', 'utf-8');

    const registry = await loadAgentRegistry(testDir);
    expect(registry.size).toBe(1);
    expect(registry.has('valid-agent')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveAgent
// ---------------------------------------------------------------------------

describe('resolveAgent', () => {
  test('returns persona for known agent name', async () => {
    const filePath = await writeAgent('my-agent.md', VALID_AGENT.replace('test-agent', 'my-agent'));
    const registry = await loadAgentRegistry(testDir);
    const persona = resolveAgent('my-agent', registry);
    expect(persona).not.toBeUndefined();
    expect(persona?.name).toBe('my-agent');
  });

  test('returns undefined for empty registry (no agents configured)', () => {
    const emptyRegistry = new Map();
    const result = resolveAgent('any-agent', emptyRegistry);
    expect(result).toBeUndefined();
  });

  test('throws agent_not_found when registry has entries but name is missing', async () => {
    const filePath = await writeAgent('known-agent.md', VALID_AGENT.replace('test-agent', 'known-agent'));
    const registry = await loadAgentRegistry(testDir);

    let err: AgentRegistryError | null = null;
    try {
      resolveAgent('unknown-agent', registry);
    } catch (e) {
      err = e as AgentRegistryError;
    }
    expect(err).not.toBeNull();
    expect(err?.code).toBe('agent_not_found');
  });
});
