import { Module } from '@nestjs/common';
import { ApiKeyRegistry } from './guards/api-key.registry';

@Module({
  providers: [ApiKeyRegistry],
  exports: [ApiKeyRegistry]
})
export class CommonModule {}
