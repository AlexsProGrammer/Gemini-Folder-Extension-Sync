import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health.controller';
import { SyncModule } from './sync/sync.module';

@Module({
  imports: [
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    DatabaseModule,
    SyncModule
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }]
})
export class AppModule {}