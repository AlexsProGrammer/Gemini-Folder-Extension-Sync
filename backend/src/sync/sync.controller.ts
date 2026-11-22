import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UseGuards
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ApiKeyGuard, type RequestWithApiKey } from '../common/guards/api-key.guard';
import { type SyncBlobRow } from '../database/schema';
import { PushSyncDto } from './dto/push-sync.dto';
import { SyncConfirmation, SyncService } from './sync.service';

const ACCOUNT_ID_PATTERN = /^[0-9a-f]{64}$/;

@Controller('api/v1/sync')
@UseGuards(ApiKeyGuard)
export class SyncController {
  constructor(@Inject(SyncService) private readonly syncService: SyncService) {}

  @Get(':accountId')
  getBlob(
    @Param('accountId') accountId: string,
    @Req() request: RequestWithApiKey,
    @Res({ passthrough: true }) reply: FastifyReply
  ): SyncBlobRow | undefined {
    this.assertValidAccountId(accountId);
    this.assertAccountAccess(request, accountId);

    const blob = this.syncService.getBlob(accountId);

    if (!blob) {
      throw new NotFoundException('No synced workspace found for this account.');
    }

    const etag = `"v${blob.version}-${blob.updatedAt}"`;
    reply.header('ETag', etag);

    const ifNoneMatch = request.headers?.['if-none-match'];
    if (ifNoneMatch && this.matchesETag(ifNoneMatch, etag)) {
      reply.code(304);
      return;
    }

    return blob;
  }

  @Post(':accountId')
  pushBlob(@Param('accountId') accountId: string, @Body() dto: PushSyncDto, @Req() request: RequestWithApiKey): SyncConfirmation {
    this.assertValidAccountId(accountId);
    this.assertAccountAccess(request, accountId);

    return this.syncService.upsertBlob(accountId, dto);
  }

  private matchesETag(ifNoneMatchHeader: string | string[], etag: string): boolean {
    const raw = Array.isArray(ifNoneMatchHeader) ? ifNoneMatchHeader.join(',') : ifNoneMatchHeader;
    return raw
      .split(',')
      .map((part) => part.trim())
      .some((candidate) => candidate === '*' || candidate === etag);
  }

  private assertValidAccountId(accountId: string): void {
    if (!ACCOUNT_ID_PATTERN.test(accountId)) {
      throw new BadRequestException('accountId must be a 64-character hexadecimal SHA-256 hash.');
    }
  }

  private assertAccountAccess(request: RequestWithApiKey, accountId: string): void {
    const identity = request.apiKeyIdentity;
    if (!identity) {
      throw new ForbiddenException('Invalid or missing API key.');
    }
    if (!identity.allowsAllAccounts && !identity.allowedAccounts.has(accountId)) {
      throw new ForbiddenException('This API key is not authorized for this account.');
    }
  }
}