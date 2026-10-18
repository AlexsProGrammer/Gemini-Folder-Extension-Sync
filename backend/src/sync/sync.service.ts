import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { syncBlobs, type SyncBlobRow } from '../database/schema';
import { PushSyncDto } from './dto/push-sync.dto';

export interface SyncConfirmation {
  status: 'success';
  version: number;
  updatedAt: number;
}

export interface VersionConflictBody {
  statusCode: 409;
  message: 'Version conflict detected';
  serverState: SyncBlobRow;
}

@Injectable()
export class SyncService {
  constructor(@Inject(DatabaseService) private readonly databaseService: DatabaseService) {}

  getBlob(accountId: string): SyncBlobRow | null {
    const row = this.databaseService.database
      .select()
      .from(syncBlobs)
      .where(eq(syncBlobs.accountId, accountId))
      .get();

    return row ?? null;
  }

  upsertBlob(accountId: string, dto: PushSyncDto): SyncConfirmation {
    const existing = this.getBlob(accountId);

    if (existing && existing.version > dto.version) {
      throw new ConflictException({
        statusCode: 409,
        message: 'Version conflict detected',
        serverState: existing
      });
    }

    this.databaseService.database
      .insert(syncBlobs)
      .values({
        accountId,
        version: dto.version,
        ciphertext: dto.ciphertext,
        iv: dto.iv,
        updatedAt: dto.updatedAt
      })
      .onConflictDoUpdate({
        target: syncBlobs.accountId,
        set: {
          version: dto.version,
          ciphertext: dto.ciphertext,
          iv: dto.iv,
          updatedAt: dto.updatedAt
        }
      })
      .run();

    return { status: 'success', version: dto.version, updatedAt: dto.updatedAt };
  }
}