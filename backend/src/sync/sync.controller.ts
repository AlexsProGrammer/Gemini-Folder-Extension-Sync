import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  UseGuards
} from '@nestjs/common';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { syncBlobs, type SyncBlobRow } from '../database/schema';
import { PushSyncDto } from './dto/push-sync.dto';
import { SyncConfirmation, SyncService } from './sync.service';

const ACCOUNT_ID_PATTERN = /^[0-9a-f]{64}$/;

@Controller('api/v1/sync')
@UseGuards(ApiKeyGuard)
export class SyncController {
  constructor(@Inject(SyncService) private readonly syncService: SyncService) {}

  @Get(':accountId')
  getBlob(@Param('accountId') accountId: string): SyncBlobRow {
    this.assertValidAccountId(accountId);

    const blob = this.syncService.getBlob(accountId);

    if (!blob) {
      throw new NotFoundException('No synced workspace found for this account.');
    }

    return blob;
  }

  @Post(':accountId')
  pushBlob(@Param('accountId') accountId: string, @Body() dto: PushSyncDto): SyncConfirmation {
    this.assertValidAccountId(accountId);

    return this.syncService.upsertBlob(accountId, dto);
  }

  private assertValidAccountId(accountId: string): void {
    if (!ACCOUNT_ID_PATTERN.test(accountId)) {
      throw new BadRequestException('accountId must be a 64-character hexadecimal SHA-256 hash.');
    }
  }
}