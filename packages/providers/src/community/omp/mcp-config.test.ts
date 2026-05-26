import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

import { loadMcpConfig } from './mcp-config';

describe('loadMcpConfig', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `omp-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

  test('filters disabled servers before connecting', async () => {
    const config = {
      enabled: { command: 'npx', args: ['enabled-server'] },
      disabled: { command: 'npx', args: ['disabled-server'], enabled: false },
    };
    await writeFile(join(testDir, 'disabled.json'), JSON.stringify(config));

    const result = await loadMcpConfig('disabled.json', testDir);

    expect(result.serverNames).toEqual(['enabled']);
    expect(result.servers).toEqual({ enabled: { command: 'npx', args: ['enabled-server'] } });
  });

  test('expands $VAR_NAME in env values from process.env', async () => {
    process.env.TEST_OMP_MCP_TOKEN = 'secret123';
    const config = { github: { command: 'npx', env: { TOKEN: '$TEST_OMP_MCP_TOKEN' } } };
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify(config));

    try {
      const result = await loadMcpConfig('mcp.json', testDir);
      const server = result.servers.github as Record<string, unknown>;

      expect(server.env).toEqual({ TOKEN: 'secret123' });
    } finally {
      delete process.env.TEST_OMP_MCP_TOKEN;
    }
  });

  test('expands ${VAR_NAME} in env and header values', async () => {
    process.env.TEST_OMP_BRACED_TOKEN = 'braced-secret';
    const config = {
      github: {
        command: 'npx',
        env: { TOKEN: '${TEST_OMP_BRACED_TOKEN}' },
        headers: { Authorization: 'Bearer ${TEST_OMP_BRACED_TOKEN}' },
      },
    };
    await writeFile(join(testDir, 'mcp-braced.json'), JSON.stringify(config));

    try {
      const result = await loadMcpConfig('mcp-braced.json', testDir);
      const server = result.servers.github as Record<string, unknown>;

      expect(server.env).toEqual({ TOKEN: 'braced-secret' });
      expect(server.headers).toEqual({ Authorization: 'Bearer braced-secret' });
    } finally {
      delete process.env.TEST_OMP_BRACED_TOKEN;
    }
  });

  test('expands $VAR_NAME in headers values', async () => {
    process.env.TEST_OMP_API_KEY = 'key456';
    const config = {
      api: {
        type: 'http',
        url: 'https://example.com',
        headers: { Authorization: 'Bearer $TEST_OMP_API_KEY' },
      },
    };
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify(config));

    try {
      const result = await loadMcpConfig('mcp.json', testDir);
      const server = result.servers.api as Record<string, unknown>;

      expect(server.headers).toEqual({ Authorization: 'Bearer key456' });
    } finally {
      delete process.env.TEST_OMP_API_KEY;
    }
  });

  test('replaces undefined env vars with empty string and reports them', async () => {
    delete process.env.NONEXISTENT_OMP_VAR;
    const config = { svc: { command: 'npx', env: { KEY: '$NONEXISTENT_OMP_VAR' } } };
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify(config));

    const result = await loadMcpConfig('mcp.json', testDir);
    const server = result.servers.svc as Record<string, unknown>;

    expect(server.env).toEqual({ KEY: '' });
    expect(result.missingVars).toContain('NONEXISTENT_OMP_VAR');
  });

  test('does not expand vars in command or args fields', async () => {
    process.env.TEST_OMP_CMD = 'should-not-expand';
    const config = { svc: { command: '$TEST_OMP_CMD', args: ['$TEST_OMP_CMD'] } };
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify(config));

    try {
      const result = await loadMcpConfig('mcp.json', testDir);
      const server = result.servers.svc as Record<string, unknown>;

      expect(server.command).toBe('$TEST_OMP_CMD');
      expect(server.args).toEqual(['$TEST_OMP_CMD']);
    } finally {
      delete process.env.TEST_OMP_CMD;
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

  test('throws on non-object env or headers entries', async () => {
    await writeFile(
      join(testDir, 'bad-env.json'),
      JSON.stringify({ github: { command: 'npx', env: ['bad'] } })
    );
    await writeFile(
      join(testDir, 'bad-headers.json'),
      JSON.stringify({ api: { type: 'http', url: 'https://example.com', headers: ['bad'] } })
    );

    await expect(loadMcpConfig('bad-env.json', testDir)).rejects.toThrow(
      'MCP server env must be a JSON object: github in bad-env.json'
    );
    await expect(loadMcpConfig('bad-headers.json', testDir)).rejects.toThrow(
      'MCP server headers must be a JSON object: api in bad-headers.json'
    );
  });
});
