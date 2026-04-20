import { mock, describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { createQueryResult, mockPostgresDialect } from '../test/mocks/database';
import type { MessageRow } from './messages';
import * as archonPaths from '@archon/paths';
import * as connectionModule from './connection';
import { createMockLogger } from '../test/mocks/logger';

const mockLogger = createMockLogger();
const mockQuery = mock(() => Promise.resolve(createQueryResult([])));
const mockGetDatabaseType = mock(() => 'postgresql' as const);

import { addMessage, listMessages, getRecentWorkflowResultMessages } from './messages';

describe('messages', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let spyCreateLogger: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let spyPoolQuery: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let spyGetDialect: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let spyGetDatabaseType: any;

  beforeEach(() => {
    spyCreateLogger = spyOn(archonPaths, 'createLogger').mockReturnValue(mockLogger as never);
    spyPoolQuery = spyOn(connectionModule.pool, 'query').mockImplementation(mockQuery as never);
    spyGetDialect = spyOn(connectionModule, 'getDialect').mockReturnValue(
      mockPostgresDialect as never
    );
    spyGetDatabaseType = spyOn(connectionModule, 'getDatabaseType').mockImplementation(
      mockGetDatabaseType as never
    );
    mockQuery.mockClear();
  });

  afterEach(() => {
    spyCreateLogger?.mockRestore();
    spyPoolQuery?.mockRestore();
    spyGetDialect?.mockRestore();
    spyGetDatabaseType?.mockRestore();
  });

  const mockMessage: MessageRow = {
    id: 'msg-123',
    conversation_id: 'conv-456',
    role: 'user',
    content: 'Hello, world!',
    metadata: '{}',
    created_at: '2025-01-01T00:00:00.000Z',
  };

  describe('addMessage', () => {
    test('calls pool.query with correct SQL and parameters', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([mockMessage]));

      const result = await addMessage('conv-456', 'user', 'Hello, world!');

      expect(result).toEqual(mockMessage);
      expect(mockQuery).toHaveBeenCalledWith(
        `INSERT INTO remote_agent_messages (conversation_id, role, content, metadata, created_at)
     VALUES ($1, $2, $3, $4, NOW())
     RETURNING *`,
        ['conv-456', 'user', 'Hello, world!', '{}']
      );
    });

    test('includes metadata as JSON string when provided', async () => {
      const messageWithMetadata: MessageRow = {
        ...mockMessage,
        metadata: '{"toolCalls":[{"name":"read"}],"error":null}',
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([messageWithMetadata]));

      const metadata = { toolCalls: [{ name: 'read' }], error: null };
      const result = await addMessage('conv-456', 'assistant', 'Done.', metadata);

      expect(result).toEqual(messageWithMetadata);
      expect(mockQuery).toHaveBeenCalledWith(expect.any(String), [
        'conv-456',
        'assistant',
        'Done.',
        JSON.stringify(metadata),
      ]);
    });

    test('defaults metadata to empty object when not provided', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([mockMessage]));

      await addMessage('conv-456', 'user', 'Hello, world!');

      expect(mockQuery).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['{}']));
    });

    test('throws wrapped error when INSERT returns no rows', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await expect(addMessage('conv-456', 'user', 'Hello')).rejects.toThrow(
        'Failed to persist message: INSERT returned no rows (conversation: conv-456)'
      );
    });

    test('propagates query errors', async () => {
      mockQuery.mockRejectedValueOnce(new Error('connection refused'));

      await expect(addMessage('conv-456', 'user', 'Hello')).rejects.toThrow('connection refused');
    });
  });

  describe('listMessages', () => {
    test('returns rows from query result', async () => {
      const messages: MessageRow[] = [
        mockMessage,
        { ...mockMessage, id: 'msg-124', role: 'assistant', content: 'Hi!' },
      ];
      mockQuery.mockResolvedValueOnce(createQueryResult(messages));

      const result = await listMessages('conv-456');

      expect(result).toEqual(messages);
      expect(mockQuery).toHaveBeenCalledWith(
        `SELECT * FROM remote_agent_messages
     WHERE conversation_id = $1
     ORDER BY created_at ASC
     LIMIT $2`,
        ['conv-456', 200]
      );
    });

    test('returns empty array for no results', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await listMessages('conv-456');

      expect(result).toEqual([]);
    });

    test('respects custom limit parameter', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await listMessages('conv-456', 50);

      expect(mockQuery).toHaveBeenCalledWith(expect.any(String), ['conv-456', 50]);
    });
  });

  describe('getRecentWorkflowResultMessages', () => {
    beforeEach(() => {
      mockGetDatabaseType.mockClear();
    });

    test('uses PostgreSQL JSON extraction syntax when dbType is postgresql', async () => {
      mockGetDatabaseType.mockReturnValueOnce('postgresql');
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await getRecentWorkflowResultMessages('conv-1');

      const sql = mockQuery.mock.calls[0]?.[0] as string;
      expect(sql).toContain("metadata->>'workflowResult'");
      expect(sql).not.toContain('json_extract');
    });

    test('uses SQLite JSON extraction syntax when dbType is sqlite', async () => {
      mockGetDatabaseType.mockReturnValueOnce('sqlite');
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await getRecentWorkflowResultMessages('conv-1');

      const sql = mockQuery.mock.calls[0]?.[0] as string;
      expect(sql).toContain("json_extract(metadata, '$.workflowResult')");
      expect(sql).not.toContain("->>'" + 'workflowResult');
    });

    test('passes correct parameters: conversationId and limit', async () => {
      mockGetDatabaseType.mockReturnValueOnce('postgresql');
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await getRecentWorkflowResultMessages('conv-42', 5);

      expect(mockQuery).toHaveBeenCalledWith(expect.any(String), ['conv-42', 5]);
    });

    test('default limit is 3', async () => {
      mockGetDatabaseType.mockReturnValueOnce('postgresql');
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await getRecentWorkflowResultMessages('conv-1');

      expect(mockQuery).toHaveBeenCalledWith(expect.any(String), ['conv-1', 3]);
    });

    test('returns empty array on query error (non-throwing contract)', async () => {
      mockGetDatabaseType.mockReturnValueOnce('postgresql');
      mockQuery.mockRejectedValueOnce(new Error('connection refused'));

      const result = await getRecentWorkflowResultMessages('conv-1');

      expect(result).toEqual([]);
    });

    test('returns rows from successful query', async () => {
      const row: MessageRow = {
        id: 'msg-1',
        conversation_id: 'conv-1',
        role: 'assistant',
        content: 'Workflow summary here.',
        metadata: '{"workflowResult":{"workflowName":"plan","runId":"run-1"}}',
        created_at: '2026-01-01T00:00:00Z',
      };
      mockGetDatabaseType.mockReturnValueOnce('postgresql');
      mockQuery.mockResolvedValueOnce(createQueryResult([row]));

      const result = await getRecentWorkflowResultMessages('conv-1');

      expect(result).toEqual([row]);
    });
  });
});
