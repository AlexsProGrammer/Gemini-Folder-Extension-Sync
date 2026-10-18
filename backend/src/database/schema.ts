import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const syncBlobs = sqliteTable('sync_blobs', {
  accountId: text('account_id').primaryKey(),
  version: integer('version').notNull(),
  ciphertext: text('ciphertext').notNull(),
  iv: text('iv').notNull(),
  updatedAt: integer('updated_at').notNull()
});

export type SyncBlobRow = typeof syncBlobs.$inferSelect;
export type NewSyncBlob = typeof syncBlobs.$inferInsert;