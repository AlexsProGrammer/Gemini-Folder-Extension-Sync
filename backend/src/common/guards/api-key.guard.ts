import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ApiKeyRegistry, type ApiKeyIdentity } from './api-key.registry';

export type RequestWithApiKey = { headers?: Record<string, string | undefined>; apiKeyIdentity?: ApiKeyIdentity };

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly registry: ApiKeyRegistry) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithApiKey>();
    const header = request.headers?.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';

    const identity = this.registry.resolve(token);
    if (!identity) {
      throw new UnauthorizedException('Invalid or missing API key.');
    }

    request.apiKeyIdentity = identity;
    return true;
  }
}
