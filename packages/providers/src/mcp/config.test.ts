import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as fsPromises from 'fs/promises';
import { mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempTree } from '@archon/paths/test-utils';
import { ClassifiedProviderError } from '../shared/failure';
import { loadMcpConfig } from './config';

async function thrownBy(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected loadMcpConfig to throw');
}

describe('loadMcpConfig failure classes', () => {
  afterEach(() => {
    mock.restore();
  });

  test.each([
    ['a missing file', 'does-not-exist.mcp.json'],
    ['a directory', tmpdir()],
  ])('%s is misconfigured', async (_label, path) => {
    const error = await thrownBy(loadMcpConfig(path, process.cwd()));
    expect(error).toBeInstanceOf(ClassifiedProviderError);
    expect((error as ClassifiedProviderError).failureClass).toBe('misconfigured');
  });

  test('a read error that can pass is not classified', async () => {
    spyOn(fsPromises, 'readFile').mockRejectedValue(
      Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' })
    );
    const error = await thrownBy(loadMcpConfig('servers.mcp.json', process.cwd()));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ClassifiedProviderError);
  });
});

describe('loadMcpConfig', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  test('loads and parses a valid MCP config JSON', async () => {
    const config = { github: { command: 'npx', args: ['-y', '@mcp/server-github'] } };
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify(config));

    const result = await loadMcpConfig('mcp.json', testDir);
    expect(result.serverNames).toEqual(['github']);
    expect(result.servers).toEqual(config);
    expect(result.missingVars).toEqual([]);
  });

  test('loads standard mcpServers-wrapped config JSON', async () => {
    const servers = { figma: { url: 'http://127.0.0.1:3845/mcp' } };
    await writeFile(join(testDir, 'wrapped.json'), JSON.stringify({ mcpServers: servers }));

    const result = await loadMcpConfig('wrapped.json', testDir);
    expect(result.serverNames).toEqual(['figma']);
    expect(result.servers).toEqual(servers);
  });

  test('rejects mixed mcpServers wrapper and top-level metadata', async () => {
    const servers = { figma: { url: 'http://127.0.0.1:3845/mcp' } };
    await writeFile(
      join(testDir, 'mixed-wrapper.json'),
      JSON.stringify({ $schema: 'https://example.com/schema.json', mcpServers: servers })
    );

    await expect(loadMcpConfig('mixed-wrapper.json', testDir)).rejects.toThrow(
      'cannot mix top-level "mcpServers" with other keys'
    );
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
    process.env.TEST_MCP_TOKEN_445 = 'secret123';
    const config = { github: { command: 'npx', env: { TOKEN: '$TEST_MCP_TOKEN_445' } } };
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify(config));

    const result = await loadMcpConfig('mcp.json', testDir);
    const server = result.servers.github as Record<string, unknown>;
    expect(server.env).toEqual({ TOKEN: 'secret123' });

    delete process.env.TEST_MCP_TOKEN_445;
  });

  test('expands $VAR_NAME in headers values', async () => {
    process.env.TEST_API_KEY_445 = 'key456';
    const config = {
      api: {
        type: 'http',
        url: 'https://example.com',
        headers: { Authorization: 'Bearer $TEST_API_KEY_445' },
      },
    };
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify(config));

    const result = await loadMcpConfig('mcp.json', testDir);
    const server = result.servers.api as Record<string, unknown>;
    expect(server.headers).toEqual({ Authorization: 'Bearer key456' });

    delete process.env.TEST_API_KEY_445;
  });

  test('replaces undefined env vars with empty string and reports them', async () => {
    delete process.env.NONEXISTENT_VAR_445;
    const config = { svc: { command: 'npx', env: { KEY: '$NONEXISTENT_VAR_445' } } };
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify(config));

    const result = await loadMcpConfig('mcp.json', testDir);
    const server = result.servers.svc as Record<string, unknown>;
    expect(server.env).toEqual({ KEY: '' });
    expect(result.missingVars).toContain('NONEXISTENT_VAR_445');
  });

  test('does not expand vars in command or args fields', async () => {
    process.env.TEST_CMD_445 = 'should-not-expand';
    const config = { svc: { command: '$TEST_CMD_445', args: ['$TEST_CMD_445'] } };
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify(config));

    const result = await loadMcpConfig('mcp.json', testDir);
    const server = result.servers.svc as Record<string, unknown>;
    expect(server.command).toBe('$TEST_CMD_445');
    expect(server.args).toEqual(['$TEST_CMD_445']);

    delete process.env.TEST_CMD_445;
  });

  test('resolves absolute paths as-is', async () => {
    const config = { svc: { command: 'npx' } };
    const absPath = join(testDir, 'abs.json');
    await writeFile(absPath, JSON.stringify(config));

    const result = await loadMcpConfig(absPath, '/some/other/dir');
    expect(result.serverNames).toEqual(['svc']);
  });

  test('throws on invalid JSON', async () => {
    await writeFile(join(testDir, 'bad.json'), 'not json');
    await expect(loadMcpConfig('bad.json', testDir)).rejects.toThrow('not valid JSON');
  });

  test('throws on non-object JSON (array)', async () => {
    await writeFile(join(testDir, 'arr.json'), '[]');
    await expect(loadMcpConfig('arr.json', testDir)).rejects.toThrow('must be a JSON object');
  });

  test('throws on non-object JSON (string)', async () => {
    await writeFile(join(testDir, 'str.json'), '"hello"');
    await expect(loadMcpConfig('str.json', testDir)).rejects.toThrow('must be a JSON object');
  });

  test('throws on array-valued server config', async () => {
    await writeFile(join(testDir, 'server-array.json'), JSON.stringify({ figma: [] }));

    await expect(loadMcpConfig('server-array.json', testDir)).rejects.toThrow(
      'MCP server "figma" must be a JSON object'
    );
  });

  test('throws on non-string env values', async () => {
    await writeFile(
      join(testDir, 'env-number.json'),
      JSON.stringify({ figma: { command: 'figma-mcp', env: { TOKEN: 123 } } })
    );

    await expect(loadMcpConfig('env-number.json', testDir)).rejects.toThrow(
      'MCP config figma.env.TOKEN must be a string'
    );
  });

  test('throws on non-string header values', async () => {
    await writeFile(
      join(testDir, 'header-array.json'),
      JSON.stringify({
        figma: {
          type: 'http',
          url: 'http://127.0.0.1:3845/mcp',
          headers: { Authorization: ['Bearer token'] },
        },
      })
    );

    await expect(loadMcpConfig('header-array.json', testDir)).rejects.toThrow(
      'MCP config figma.headers.Authorization must be a string'
    );
  });

  test('expands ${VAR_NAME} brace-form in env values', async () => {
    process.env.TEST_MCP_TOKEN_1612 = 'braced-secret';
    const config = { github: { command: 'npx', env: { TOKEN: '${TEST_MCP_TOKEN_1612}' } } };
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify(config));

    const result = await loadMcpConfig('mcp.json', testDir);
    const server = result.servers.github as Record<string, unknown>;
    expect(server.env).toEqual({ TOKEN: 'braced-secret' });

    delete process.env.TEST_MCP_TOKEN_1612;
  });

  test('expands ${VAR_NAME} brace-form in headers values', async () => {
    process.env.TEST_API_KEY_1612 = 'braced-key';
    const config = {
      api: {
        type: 'http',
        url: 'https://example.com',
        headers: { Authorization: 'Bearer ${TEST_API_KEY_1612}' },
      },
    };
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify(config));

    const result = await loadMcpConfig('mcp.json', testDir);
    const server = result.servers.api as Record<string, unknown>;
    expect(server.headers).toEqual({ Authorization: 'Bearer braced-key' });

    delete process.env.TEST_API_KEY_1612;
  });

  test('replaces undefined brace-form vars with empty string and reports them', async () => {
    delete process.env.NONEXISTENT_VAR_1612;
    const config = { svc: { command: 'npx', env: { KEY: '${NONEXISTENT_VAR_1612}' } } };
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify(config));

    const result = await loadMcpConfig('mcp.json', testDir);
    const server = result.servers.svc as Record<string, unknown>;
    expect(server.env).toEqual({ KEY: '' });
    expect(result.missingVars).toContain('NONEXISTENT_VAR_1612');
  });

  test('expands mixed bare and brace-form vars in the same string', async () => {
    process.env.TEST_HOST_1612 = 'db.example.com';
    process.env.TEST_PORT_1612 = '5432';
    const config = {
      db: {
        command: 'npx',
        env: { DSN: 'postgres://$TEST_HOST_1612:${TEST_PORT_1612}/mydb' },
      },
    };
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify(config));

    const result = await loadMcpConfig('mcp.json', testDir);
    const server = result.servers.db as Record<string, unknown>;
    expect(server.env).toEqual({ DSN: 'postgres://db.example.com:5432/mydb' });

    delete process.env.TEST_HOST_1612;
    delete process.env.TEST_PORT_1612;
  });

  test('does not expand brace-form vars in command or args fields', async () => {
    process.env.TEST_CMD_1612 = 'should-not-expand';
    const config = { svc: { command: '${TEST_CMD_1612}', args: ['${TEST_CMD_1612}'] } };
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify(config));

    const result = await loadMcpConfig('mcp.json', testDir);
    const server = result.servers.svc as Record<string, unknown>;
    expect(server.command).toBe('${TEST_CMD_1612}');
    expect(server.args).toEqual(['${TEST_CMD_1612}']);

    delete process.env.TEST_CMD_1612;
  });
});
