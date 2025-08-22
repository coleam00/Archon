/**
 * Tests for DatabaseService
 *
 * This test suite validates:
 * - Singleton pattern implementation
 * - Error handling for network and server failures
 * - JSON parsing resilience
 * - Response handling with missing or extra fields
 * - Complete database setup flow verification
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  MockedFunction,
} from 'vitest';

vi.mock('../../src/config/api', () => ({
  getApiUrl: () => 'http://localhost:8181',
}));

import { DatabaseService } from '../../src/services/databaseService';

describe('DatabaseService', () => {
  let originalFetch: typeof global.fetch;
  let mockFetch: MockedFunction<typeof fetch>;

  beforeEach(() => {
    originalFetch = global.fetch;

    // @ts-expect-error - accessing private static property for testing
    DatabaseService.instance = undefined;

    mockFetch = vi.fn() as unknown as MockedFunction<typeof fetch>;
    global.fetch = mockFetch as unknown as typeof fetch;

    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('Singleton Pattern', () => {
    it('should return the same instance across multiple calls', () => {
      const instance1 = DatabaseService.getInstance();
      const instance2 = DatabaseService.getInstance();

      expect(instance1).toBe(instance2);
    });
  });

  describe('Error Handling', () => {
    let service: DatabaseService;

    beforeEach(() => {
      service = DatabaseService.getInstance();
    });

    it('should provide helpful message when server is unreachable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Failed to fetch'));

      await expect(service.getStatus()).rejects.toThrow('Failed to fetch');
    });

    it('should guide user on server errors with clear context', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      } as unknown as Response);

      await expect(service.getStatus()).rejects.toThrow(
        'Database connection failed: Internal Server Error'
      );

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      } as unknown as Response);

      await expect(service.getSetupSQL()).rejects.toThrow(
        'Setup SQL configuration error: Unauthorized'
      );
    });

    it('should handle malformed JSON responses gracefully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.reject(new Error('Unexpected token')),
      } as unknown as Response);

      await expect(service.getStatus()).rejects.toThrow('Unexpected token');
    });
  });

  describe('Response Resilience', () => {
    let service: DatabaseService;

    beforeEach(() => {
      service = DatabaseService.getInstance();
    });

    it('should handle responses with missing optional fields', async () => {
      const partialResponse = {
        sql_content: 'CREATE TABLE test();',
        project_id: null,
        sql_editor_url: null,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(partialResponse),
      } as unknown as Response);

      const result = await service.getSetupSQL();
      expect(result.sql_content).toBe('CREATE TABLE test();');
      expect(result.project_id).toBeNull();
      expect(result.sql_editor_url).toBeNull();
    });

    it('should handle responses with extra unexpected fields', async () => {
      const responseWithExtra = {
        initialized: true,
        setup_required: false,
        message: 'Database is ready',
        extra_field: 'should not break anything',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(responseWithExtra),
      } as unknown as Response);

      const result = await service.getStatus();
      expect(result.initialized).toBe(true);
      expect(result.setup_required).toBe(false);
      expect(result.message).toBe('Database is ready');
    });
  });

  describe('Database Setup Flow', () => {
    let service: DatabaseService;

    beforeEach(() => {
      service = DatabaseService.getInstance();
    });

    it('should complete full setup verification flow', async () => {
      const statusResponse = {
        initialized: false,
        setup_required: true,
        message: 'Setup required',
      };

      const setupSQLResponse = {
        sql_content: 'CREATE TABLE test();',
        project_id: 'test-project',
        sql_editor_url: 'https://example.com/sql',
      };

      const verifyResponse = {
        success: true,
        message: 'Setup verified successfully',
      };

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(statusResponse),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(setupSQLResponse),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(verifyResponse),
        } as unknown as Response);

      const status = await service.getStatus();
      expect(status.setup_required).toBe(true);

      const setupSQL = await service.getSetupSQL();
      expect(setupSQL.sql_content).toBe('CREATE TABLE test();');

      const verification = await service.verifySetup();
      expect(verification.success).toBe(true);
    });
  });
});
