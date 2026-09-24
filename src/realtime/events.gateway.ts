import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { createClient } from '@supabase/supabase-js';
import type { Server, Socket } from 'socket.io';

export const COACH_ROOM = 'coach:all';
export function memberRoom(userId: string) {
  return `member:${userId}`;
}

@WebSocketGateway({
  namespace: '/realtime',
  cors: {
    origin: true,
    credentials: true,
  },
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(EventsGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(private readonly jwt: JwtService) {}

  async handleConnection(@ConnectedSocket() client: Socket) {
    try {
      const token = this.extractToken(client);
      if (!token) {
        client.disconnect(true);
        return;
      }

      const coach = this.tryCoach(token);
      if (coach) {
        client.data.role = 'coach';
        client.data.email = coach.email;
        await client.join(COACH_ROOM);
        this.logger.debug(`Coach connected ${coach.email}`);
        return;
      }

      const member = await this.tryMember(token);
      if (member) {
        client.data.role = 'member';
        client.data.userId = member.userId;
        await client.join(memberRoom(member.userId));
        this.logger.debug(`Member connected ${member.userId}`);
        return;
      }

      client.disconnect(true);
    } catch (error) {
      this.logger.warn(`Realtime auth failed: ${error instanceof Error ? error.message : error}`);
      client.disconnect(true);
    }
  }

  handleDisconnect(@ConnectedSocket() client: Socket) {
    this.logger.debug(`Socket disconnected ${client.id}`);
  }

  emitToMember(userId: string, event: string, payload: Record<string, unknown>) {
    this.server?.to(memberRoom(userId)).emit(event, payload);
  }

  emitToCoaches(event: string, payload: Record<string, unknown>) {
    this.server?.to(COACH_ROOM).emit(event, payload);
  }

  private extractToken(client: Socket) {
    const auth = client.handshake.auth as { token?: string } | undefined;
    if (auth?.token?.trim()) return auth.token.trim();
    const header = client.handshake.headers.authorization || '';
    if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
      return header.slice(7).trim();
    }
    const queryToken = client.handshake.query.token;
    if (typeof queryToken === 'string' && queryToken.trim()) return queryToken.trim();
    return '';
  }

  private tryCoach(token: string) {
    try {
      const payload = this.jwt.verify<{ role?: string; email?: string }>(token);
      if (payload.role !== 'coach') return null;
      return { email: (payload.email || '').trim().toLowerCase() };
    } catch {
      return null;
    }
  }

  private async tryMember(token: string) {
    try {
      const payload = this.jwt.verify<{
        role?: string;
        sub?: string;
        email?: string;
      }>(token);
      if (payload.role === 'member' && payload.sub) {
        return { userId: payload.sub };
      }
    } catch {
      /* not a Nest member JWT */
    }

    const url = process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
    const anon =
      process.env.SUPABASE_ANON_KEY?.trim() ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
    if (!url || !anon) return null;

    const supabase = createClient(url, anon, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user?.id) return null;
    return { userId: data.user.id };
  }
}
