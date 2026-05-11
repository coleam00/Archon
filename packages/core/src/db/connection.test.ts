import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { getDatabaseType, resetDatabase } from './connection';

describe('connection', () => {
  describe('getDatabaseType', () => {
    let originalDatabaseUrl: string | undefined;

    beforeEach(() => {
      originalDatabaseUrl = process.env.DATABASE_URL;
      // Reset the database singleton to ensure clean state
      resetDatabase();
    });

    afterEach(() => {
      // Restore original DATABASE_URL
      if (originalDatabaseUrl !== undefined) {
        process.env.DATABASE_URL = originalDatabaseUrl;
      } else {
        delete process.env.DATABASE_URL;
      }
      resetDatabase();
    });

    it('should return postgresql when DATABASE_URL is set', () => {
      process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
      expect(getDatabaseType()).toBe('postgresql');
    });

    it('should return sqlite when DATABASE_URL is not set', () => {
      delete process.env.DATABASE_URL;
      expect(getDatabaseType()).toBe('sqlite');
    });

    it('should return postgresql for any truthy DATABASE_URL value', () => {
      process.env.DATABASE_URL = 'postgres://user:pass@host:5432/db';
      expect(getDatabaseType()).toBe('postgresql');

      process.env.DATABASE_URL = 'postgresql://localhost/mydb';
      expect(getDatabaseType()).toBe('postgresql');
    });

    it('should return sqlite when DATABASE_URL is empty string', () => {
      process.env.DATABASE_URL = '';
      expect(getDatabaseType()).toBe('sqlite');
    });

    it('should not initialize database connection', () => {
      // getDatabaseType should work without connecting to database
      // This is important for version command that runs without db
      delete process.env.DATABASE_URL;

      // Should not throw even without a database available
      const result = getDatabaseType();
      expect(result).toBe('sqlite');
    });
  });
});
