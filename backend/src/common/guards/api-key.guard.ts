import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ headers?: Record<string, string | undefined> }>();
    const header = request.headers?.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    const expected = process.env.API_KEY ?? '';

    if (token.length === 0 || expected.length === 0 || !this.tokensMatch(token, expected)) {
      throw new UnauthorizedException('Invalid or missing API key.');
    }

    return true;
  }

  private tokensMatch(provided: string, expected: string): boolean {
    const providedHash = createHash('sha256').update(provided).digest();
    const expectedHash = createHash('sha256').update(expected).digest();

    return timingSafeEqual(providedHash, expectedHash);
  }
}