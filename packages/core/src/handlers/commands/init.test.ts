// @archon-test-isolated
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { join } from 'path';
import { handleCommand } from '../command-handler';
import {
  operator,
  makeCodebase,
  mockGetCodebase,
  spyFsMkdir,
  spyFsWriteFile,
  restoreSpies,
  baseConversation,
  resetCommandHandlerMocks,
} from './test-harness';

describe('CommandHandler', () => {
  beforeEach(resetCommandHandlerMocks);

  // Clean up spies after all tests in this file to prevent contamination
  afterAll(() => {
    restoreSpies();
  });

  describe('handleCommand', () => {
    describe('/init', () => {
      test('uses codebase default cwd when conversation cwd is unset', async () => {
        const conversation = {
          ...baseConversation,
          codebase_id: 'cb-123',
          cwd: null,
        };
        mockGetCodebase.mockResolvedValue(
          makeCodebase({
            id: 'cb-123',
            name: 'my-repo',
            repository_url: 'https://github.com/user/my-repo',
            default_cwd: '/workspace/my-repo',
            default_branch: 'main',
          })
        );

        const result = await handleCommand(conversation, '/init', operator);

        expect(result.success).toBe(true);
        expect(spyFsMkdir).toHaveBeenCalledWith(join('/workspace/my-repo', '.archon', 'commands'), {
          recursive: true,
        });
        expect(spyFsWriteFile).toHaveBeenCalledWith(
          join('/workspace/my-repo', '.archon', 'config.yaml'),
          expect.any(String)
        );
      });

      test('returns clear error when no cwd or codebase context exists', async () => {
        const result = await handleCommand(baseConversation, '/init', operator);

        expect(result.success).toBe(false);
        expect(result.message).toContain('No project selected');
        expect(result.message).toContain('/setproject');
      });

      test('explicit conversation.cwd wins over the codebase default', async () => {
        const conversation = {
          ...baseConversation,
          codebase_id: 'cb-123',
          cwd: '/explicit/worktree',
        };
        mockGetCodebase.mockResolvedValue(
          makeCodebase({
            id: 'cb-123',
            name: 'my-repo',
            repository_url: 'https://github.com/user/my-repo',
            default_cwd: '/workspace/my-repo',
            default_branch: 'main',
          })
        );

        const result = await handleCommand(conversation, '/init', operator);

        expect(result.success).toBe(true);
        expect(spyFsMkdir).toHaveBeenCalledWith(join('/explicit/worktree', '.archon', 'commands'), {
          recursive: true,
        });
      });
    });
  });
});
