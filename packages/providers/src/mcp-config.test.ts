import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

import { loadMcpConfig } from './mcp-config';

describe('loadMcpConfig', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `providers-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test('loads and parses a valid MCP config JSON', async () => {
    const config = { github: { command: 'npx', args: ['-y', '@mcp/server-github'] } };
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify(config));

    const result = await loadMcpConfig('mcp.json', testDir);

    expect(result.serverNames).toEqual(['github']);
    expect(result.servers).toEqual(config);
    expect(result.missingVars).toEqual([]);
  });

  test('loads multiple servers from one config', async () => {
    const config = {
      github: { command: 'npx', args: ['-y', '@mcp/server-github'] },
      postgres: { command: 'npx', args: ['-y', '@mcp/server-postgres'] },
    };
    await writeFile(join(testDir, 'multi.json'), JSON.stringify(config));

    const result = await loadMcpConfig('multi.json', testDir);

    expect(result.serverNames).toEqual(['github', 'postgres']);
  });

  test('expands $VAR_NAME in env values from process.env', async () => {
    process.env.TEST_MCP_TOKEN_PROVIDERS = 'secret123';
    const config = { github: { command: 'npx', env: { TOKEN: '$TEST_MCP_TOKEN_PROVIDERS' } } };
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify(config));

    try {
      const result = await loadMcpConfig('mcp.json', testDir);
      const server = result.servers.github as Record<string, unknown>;

      expect(server.env).toEqual({ TOKEN: 'secret123' });
    } finally {
      delete process.env.TEST_MCP_TOKEN_PROVIDERS;
    }
  });

  test('expands $VAR_NAME in headers values', async () => {
    process.env.TEST_API_KEY_PROVIDERS = 'key456';
    const config = {
      api: {
        type: 'http',
        url: 'https://example.com',
        headers: { Authorization: 'Bearer $TEST_API_KEY_PROVIDERS' },
      },
    };
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify(config));

    try {
      const result = await loadMcpConfig('mcp.json', testDir);
      const server = result.servers.api as Record<string, unknown>;

      expect(server.headers).toEqual({ Authorization: 'Bearer key456' });
    } finally {
      delete process.env.TEST_API_KEY_PROVIDERS;
    }
  });

  test('replaces undefined env vars with empty string and reports them', async () => {
    delete process.env.NONEXISTENT_VAR_PROVIDERS;
    const config = { svc: { command: 'npx', env: { KEY: '$NONEXISTENT_VAR_PROVIDERS' } } };
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify(config));

    const result = await loadMcpConfig('mcp.json', testDir);
    const server = result.servers.svc as Record<string, unknown>;

    expect(server.env).toEqual({ KEY: '' });
    expect(result.missingVars).toContain('NONEXISTENT_VAR_PROVIDERS');
  });

  test('does not expand vars in command or args fields', async () => {
    process.env.TEST_CMD_PROVIDERS = 'should-not-expand';
    const config = { svc: { command: '$TEST_CMD_PROVIDERS', args: ['$TEST_CMD_PROVIDERS'] } };
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify(config));

    try {
      const result = await loadMcpConfig('mcp.json', testDir);
      const server = result.servers.svc as Record<string, unknown>;

      expect(server.command).toBe('$TEST_CMD_PROVIDERS');
      expect(server.args).toEqual(['$TEST_CMD_PROVIDERS']);
    } finally {
      delete process.env.TEST_CMD_PROVIDERS;
    }
  });

  test('resolves absolute paths as-is', async () => {
    const config = { svc: { command: 'npx' } };
    const absPath = join(testDir, 'abs.json');
    await writeFile(absPath, JSON.stringify(config));

    const result = await loadMcpConfig(absPath, '/some/other/dir');

    expect(result.serverNames).toEqual(['svc']);
  });

  test('throws on missing file', async () => {
    await expect(loadMcpConfig('nonexistent.json', testDir)).rejects.toThrow(
      'MCP config file not found'
    );
  });

  test('throws on invalid JSON', async () => {
    await writeFile(join(testDir, 'bad.json'), 'not json');

    await expect(loadMcpConfig('bad.json', testDir)).rejects.toThrow('not valid JSON');
  });

  test('throws on non-object JSON values', async () => {
    await writeFile(join(testDir, 'arr.json'), '[]');
    await writeFile(join(testDir, 'str.json'), '"hello"');

    await expect(loadMcpConfig('arr.json', testDir)).rejects.toThrow('must be a JSON object');
    await expect(loadMcpConfig('str.json', testDir)).rejects.toThrow('must be a JSON object');
  });

  test('throws on non-object server config entries', async () => {
    await writeFile(join(testDir, 'bad-server.json'), JSON.stringify({ github: 'bad' }));

    await expect(loadMcpConfig('bad-server.json', testDir)).rejects.toThrow(
      'MCP server config must be a JSON object: github in bad-server.json'
    );
  });
});
