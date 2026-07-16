import { describe, expect, test } from 'bun:test';
import * as omp from '@oh-my-pi/pi-coding-agent';
import * as ompMcp from '@oh-my-pi/pi-coding-agent/mcp';

describe('Oh My Pi v17 runtime compatibility', () => {
  test('keeps the session and MCP exports used by the provider', () => {
    expect(omp.createAgentSession).toBeFunction();
    expect(omp.discoverAuthStorage).toBeFunction();
    expect(omp.discoverSkills).toBeFunction();
    expect(omp.ModelRegistry).toBeFunction();
    expect(omp.SessionManager).toBeFunction();
    expect(omp.Settings).toBeFunction();
    expect(ompMcp.MCPManager).toBeFunction();
  });

  test('exposes the v17 built-in tool registry', () => {
    expect(omp.BUILTIN_TOOLS.hub).toBeFunction();
    expect('job' in omp.BUILTIN_TOOLS).toBe(false);
    expect('launch' in omp.BUILTIN_TOOLS).toBe(false);
    expect('ssh' in omp.BUILTIN_TOOLS).toBe(false);
  });

  test('keeps upstream defaults and round-trips Archon-supported settings', () => {
    const defaults = omp.Settings.isolated({});
    expect(defaults.get('tools.xdev')).toBe(true);
    expect(defaults.get('astGrep.enabled')).toBe(false);

    const overrides = {
      'tools.xdev': false,
      'edit.enforceSeenLines': true,
      'task.prewalk': true,
      'task.agentPrewalk': { reviewer: '@smol' },
      'generate_image.enabled': false,
      'astGrep.enabled': true,
    };
    const settings = omp.Settings.isolated(overrides);

    expect(settings.get('tools.xdev')).toBe(false);
    expect(settings.get('edit.enforceSeenLines')).toBe(true);
    expect(settings.get('task.prewalk')).toBe(true);
    expect(settings.get('task.agentPrewalk')).toEqual({ reviewer: '@smol' });
    expect(settings.get('generate_image.enabled')).toBe(false);
    expect(settings.get('astGrep.enabled')).toBe(true);
  });
});
