import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as schema from './schema';

export type AppDatabase = BetterSQLite3Database<typeof schema>;

const BOOTSTRAP_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS sync_blobs (
  account_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private sqlite: Database.Database | null = null;
  private drizzleDb: AppDatabase | null = null;

  async onModuleInit(): Promise<void> {
    const dbPath = process.env.DB_PATH || './data/sync.db';
    mkdirSync(dirname(dbPath), { recursive: true });

    this.sqlite = new Database(dbPath);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('busy_timeout = 5000');
    this.drizzleDb = drizzle(this.sqlite, { schema });

    try {
      migrate(this.drizzleDb, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
    } catch {
      this.sqlite.exec(BOOTSTRAP_TABLE_SQL);
    }
  }

  get database(): AppDatabase {
    if (!this.drizzleDb) {
      throw new Error('Database is not initialized yet.');
    }
    return this.drizzleDb;
  }

  async onModuleDestroy(): Promise<void> {
    this.sqlite?.close();
    this.sqlite = null;
    this.drizzleDb = null;
  }
}