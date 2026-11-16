// @archon-test-isolated
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { getDatabase, getDatabaseType, resetDatabase } from './connection';

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
  });
});

describe('getDatabase', () => {
  const trackTempRoot = trackTempRoots();
  let originalHome: string | undefined;
  let originalDatabaseUrl: string | undefined;

  beforeEach(() => {
    originalHome = process.env.ARCHON_HOME;
    originalDatabaseUrl = process.env.DATABASE_URL;
    resetDatabase();
  });

  afterEach(() => {
    for (const [key, value] of [
      ['ARCHON_HOME', originalHome],
      ['DATABASE_URL', originalDatabaseUrl],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetDatabase();
  });

  it('refuses, writing nothing, when this checkout sits inside the home workspaces', () => {
    const home = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-home-')));
    const repoRoot = resolve(import.meta.dir, '..', '..', '..', '..');
    symlinkSync(dirname(repoRoot), join(home, 'workspaces'), 'junction');
    process.env.ARCHON_HOME = home;
    delete process.env.DATABASE_URL;

    expect(() => getDatabase()).toThrow(/Set ARCHON_HOME to a scratch directory/);
    expect(existsSync(join(home, 'archon.db'))).toBe(false);
  });
});
