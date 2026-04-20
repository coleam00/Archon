/**
 * Tests for validate command output formatting.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCommandsCommand } from './validate';

describe('validateCommandsCommand', () => {
  let tempDir: string;
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'archon-cli-validate-'));
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    await rm(tempDir, { recursive: true, force: true });
  });

  function loggedOutput(): string {
    return consoleLogSpy.mock.calls.map(call => call.map(String).join(' ')).join('\n');
  }

  it('localizes missing command issue in text output', async () => {
    const exitCode = await validateCommandsCommand(tempDir, 'definitely-missing-command', false);

    expect(exitCode).toBe(1);
    const output = loggedOutput();
    expect(output).toContain("Command 'definitely-missing-command'을(를) 찾지 못했습니다");
    expect(output).toContain('.archon/commands/definitely-missing-command.md 파일을 만드세요');
    expect(output).not.toContain("Command 'definitely-missing-command' not found");
    expect(output).not.toContain('Create .archon/commands/definitely-missing-command.md');
  });

  it('preserves validator issue text in JSON output', async () => {
    const exitCode = await validateCommandsCommand(tempDir, 'definitely-missing-command', true);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(consoleLogSpy.mock.calls.at(-1)?.[0] as string) as {
      commandName: string;
      valid: boolean;
      issues: { message: string; hint: string }[];
    };

    expect(parsed.commandName).toBe('definitely-missing-command');
    expect(parsed.valid).toBe(false);
    expect(parsed.issues[0]).toMatchObject({
      message: "Command 'definitely-missing-command' not found",
      hint: 'Create .archon/commands/definitely-missing-command.md',
    });
  });
});
