import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

@Injectable()
export class CoachGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization || '';
    const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    if (!token) throw new UnauthorizedException();

    try {
      const payload = this.jwt.verify<{ role?: string; email?: string }>(token);
      if (payload.role !== 'coach') throw new UnauthorizedException();
      request.headers['x-coach-email'] = payload.email || '';
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }
}
