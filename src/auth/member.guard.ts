import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';
import type { Request } from 'express';
import { AuthService } from './auth.service.js';
import { MEMBER_USER_KEY, type MemberUser } from './member.types.js';

@Injectable()
export class MemberGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<
      Request & { [MEMBER_USER_KEY]?: MemberUser }
    >();
    const header = request.headers.authorization || '';
    const token = header.toLowerCase().startsWith('bearer ')
      ? header.slice(7).trim()
      : '';
    if (!token) throw new UnauthorizedException();

    // Prefer Nest-issued member JWTs (Google via backend).
    const nest = this.auth.verifyMemberToken(token);
    if (nest) {
      request[MEMBER_USER_KEY] = {
        userId: nest.sub,
        email: nest.email,
        fullName: nest.fullName || null,
        avatarUrl: nest.avatarUrl || null,
      };
      return true;
    }

    // Fallback: email OTP still uses Supabase Auth tokens.
    const member = await this.verifySupabase(token);
    if (!member) throw new UnauthorizedException();
    request[MEMBER_USER_KEY] = member;
    return true;
  }

  private async verifySupabase(token: string): Promise<MemberUser | null> {
    const url =
      process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
    const anon =
      process.env.SUPABASE_ANON_KEY?.trim() ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
    if (!url || !anon) return null;

    const supabase = createClient(url, anon, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user?.id) return null;

    const email = (data.user.email || '').trim().toLowerCase();
    const meta = (data.user.user_metadata || {}) as Record<string, unknown>;
    const fullName = [meta.full_name, meta.name, meta.display_name]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .find((value) => value.length > 0);
    const avatarUrl = [meta.avatar_url, meta.picture]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .find((value) => value.length > 0);
    return {
      userId: data.user.id,
      email,
      fullName: fullName || null,
      avatarUrl: avatarUrl || null,
    };
  }
}
