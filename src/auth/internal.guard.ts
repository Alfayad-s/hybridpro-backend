import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import type { Request } from 'express';

@Injectable()
export class InternalGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    const secret = process.env.INTERNAL_API_SECRET?.trim();
    if (!secret) throw new UnauthorizedException('INTERNAL_API_SECRET is not configured');

    const header = request.headers.authorization || '';
    const token = header.toLowerCase().startsWith('bearer ')
      ? header.slice(7).trim()
      : String(request.headers['x-internal-api-secret'] || '');

    if (!token) throw new UnauthorizedException();
    const expected = Buffer.from(secret);
    const received = Buffer.from(token);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      throw new UnauthorizedException();
    }
    return true;
  }
}
