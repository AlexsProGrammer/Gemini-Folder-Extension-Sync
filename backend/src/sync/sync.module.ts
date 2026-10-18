import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';

@Module({
  imports: [DatabaseModule],
  controllers: [SyncController],
  providers: [SyncService]
})
export class SyncModule {}