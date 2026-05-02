import { Database } from 'bun:sqlite';
import { createLogger } from '@archon/paths';
import { regimeSchema } from './schemas';
import type { ITradeStore, TradeRecord, StoredTrade, Regime } from './types';

const log = createLogger('market-regime.db');

interface TradeRow {
  id: number;
  strategy: string;
  regime: string;
  volatility: number;
  pnl: number;
  success: number;
  timestamp: string;
}

function rowToStoredTrade(row: TradeRow): StoredTrade {
  return {
    id: row.id,
    strategy: row.strategy,
    regime: regimeSchema.parse(row.regime),
    volatility: row.volatility,
    pnl: row.pnl,
    success: row.success === 1,
    timestamp: row.timestamp,
  };
}

export function createTradeStore(dbPath = ':memory:'): ITradeStore {
  let db: Database;
  try {
    db = new Database(dbPath);
    db.run('PRAGMA journal_mode = WAL');
    db.run('PRAGMA busy_timeout = 5000');
    db.run('PRAGMA foreign_keys = ON');
    db.run(`
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        strategy TEXT NOT NULL,
        regime TEXT NOT NULL,
        volatility REAL NOT NULL,
        pnl REAL NOT NULL,
        success INTEGER NOT NULL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  } catch (err) {
    log.error({ err, dbPath }, 'db.initialize_failed');
    throw new Error(`Failed to initialize trade store at ${dbPath}: ${(err as Error).message}`);
  }

  const insertStmt = db.prepare<TradeRow, [string, string, number, number, number]>(
    `INSERT INTO trades (strategy, regime, volatility, pnl, success)
     VALUES (?, ?, ?, ?, ?)
     RETURNING id, strategy, regime, volatility, pnl, success, timestamp`
  );

  const selectByStrategyRegimeStmt = db.prepare<TradeRow, [string, string]>(
    'SELECT id, strategy, regime, volatility, pnl, success, timestamp FROM trades WHERE strategy = ? AND regime = ?'
  );

  const selectAllStmt = db.prepare<TradeRow, []>(
    'SELECT id, strategy, regime, volatility, pnl, success, timestamp FROM trades'
  );

  const distinctStrategiesStmt = db.prepare<{ strategy: string }, []>(
    'SELECT DISTINCT strategy FROM trades'
  );

  const store: ITradeStore = {
    initialize(): void {
      // Table already created in constructor before prepared statements
      log.info('db.initialize_completed');
    },

    insertTrade(trade: TradeRecord): StoredTrade {
      try {
        const row = insertStmt.get(
          trade.strategy,
          trade.regime,
          trade.volatility,
          trade.pnl,
          trade.success ? 1 : 0
        );
        if (!row) throw new Error('INSERT RETURNING returned no row');
        const stored = rowToStoredTrade(row);
        log.info(
          { tradeId: stored.id, strategy: stored.strategy, regime: stored.regime },
          'trade.insert_completed'
        );
        return stored;
      } catch (err) {
        log.error({ err, strategy: trade.strategy }, 'trade.insert_failed');
        throw err;
      }
    },

    getTradesByStrategyAndRegime(strategy: string, regime: Regime): StoredTrade[] {
      return selectByStrategyRegimeStmt.all(strategy, regime).map(rowToStoredTrade);
    },

    getAllStrategies(): string[] {
      return distinctStrategiesStmt.all().map(r => r.strategy);
    },

    getAllTrades(): StoredTrade[] {
      return selectAllStmt.all().map(rowToStoredTrade);
    },

    close(): void {
      db.close();
      log.info('db.close_completed');
    },
  };

  store.initialize();
  return store;
}
