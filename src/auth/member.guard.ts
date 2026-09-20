import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';
import type { Request } from 'express';
import { MEMBER_USER_KEY, type MemberUser } from './member.types.js';

@Injectable()
export class MemberGuard implements CanActivate {
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<
      Request & { [MEMBER_USER_KEY]?: MemberUser }
    >();
    const header = request.headers.authorization || '';
    const token = header.toLowerCase().startsWith('bearer ')
      ? header.slice(7).trim()
      : '';
    if (!token) throw new UnauthorizedException();

    const url = process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
    const anon =
      process.env.SUPABASE_ANON_KEY?.trim() ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
    if (!url || !anon) {
      throw new UnauthorizedException('Supabase is not configured');
    }

    const supabase = createClient(url, anon, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user?.id) throw new UnauthorizedException();

    const email = (data.user.email || '').trim().toLowerCase();
    const meta = (data.user.user_metadata || {}) as Record<string, unknown>;
    const fullName = [meta.full_name, meta.name, meta.display_name]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .find((value) => value.length > 0);
    const avatarUrl = [meta.avatar_url, meta.picture]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .find((value) => value.length > 0);
    request[MEMBER_USER_KEY] = {
      userId: data.user.id,
      email,
      fullName: fullName || null,
      avatarUrl: avatarUrl || null,
    };
    return true;
  }
}
