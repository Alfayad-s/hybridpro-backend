import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { MEMBER_USER_KEY, type MemberUser } from './member.types.js';

export const CurrentMember = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): MemberUser => {
    const request = ctx.switchToHttp().getRequest<Request & { [MEMBER_USER_KEY]?: MemberUser }>();
    const member = request[MEMBER_USER_KEY];
    if (!member?.userId) {
      throw new Error('Member context missing');
    }
    return member;
  },
);
