import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, gt, lt, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DB } from '../db/db.module.js';
import {
  coachConversations,
  coachMessages,
  profiles,
  subscriptions,
} from '../db/schema.js';
import { RealtimeFanoutService } from '../realtime/realtime-fanout.service.js';

type Db = PostgresJsDatabase<typeof import('../db/schema.js')>;

const BODY_MAX = 4000;
const DEFAULT_LIMIT = 40;

export type PublicChatMessage = {
  id: string;
  conversationId: string;
  senderRole: 'member' | 'coach';
  senderUserId: string | null;
  senderCoachEmail: string | null;
  body: string;
  imageUrl: string | null;
  createdAt: string;
};

export type PublicConversation = {
  id: string;
  subscriptionId: string;
  memberUserId: string;
  lastMessageAt: string | null;
  memberLastReadAt: string | null;
  coachLastReadAt: string | null;
  createdAt: string;
  unreadCount: number;
};

@Injectable()
export class ChatService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly fanout: RealtimeFanoutService,
  ) {}

  async getMemberThread(member: { userId: string; email: string }, limit = DEFAULT_LIMIT) {
    const sub = await this.requireActiveLinkedSubscription(member);
    const conversation = await this.ensureConversation(sub.id, member.userId);
    const messages = await this.listMessages(conversation.id, { limit });
    const unread = await this.countUnreadForMember(conversation);
    return {
      conversation: this.toConversation(conversation, unread),
      messages,
    };
  }

  async listMemberMessages(
    member: { userId: string; email: string },
    opts: { before?: string; limit?: number },
  ) {
    const sub = await this.requireActiveLinkedSubscription(member);
    const conversation = await this.ensureConversation(sub.id, member.userId);
    const messages = await this.listMessages(conversation.id, opts);
    return { conversationId: conversation.id, messages };
  }

  async sendMemberMessage(member: { userId: string; email: string }, body?: string) {
    const text = this.normalizeBody(body);
    const sub = await this.requireActiveLinkedSubscription(member);
    const conversation = await this.ensureConversation(sub.id, member.userId);
    const message = await this.insertMessage({
      conversationId: conversation.id,
      senderRole: 'member',
      senderUserId: member.userId,
      senderCoachEmail: null,
      body: text,
      imageUrl: null,
    });

    const now = new Date(message.createdAt);
    await this.db
      .update(coachConversations)
      .set({ lastMessageAt: now, memberLastReadAt: now })
      .where(eq(coachConversations.id, conversation.id));

    const profileName = await this.profileName(member.userId);
    const preview = this.preview(text);
    await this.fanout.toCoaches(
      'chat.message',
      {
        type: 'chat.message',
        conversationId: conversation.id,
        subscriptionId: sub.id,
        memberUserId: member.userId,
        email: sub.email,
        fullName: profileName ?? '',
        messageId: message.id,
        senderRole: 'member',
        body: message.body,
        imageUrl: message.imageUrl ?? '',
        createdAt: message.createdAt,
        route: `/clients/${sub.id}`,
      },
      {
        title: profileName || sub.email || 'Member',
        body: preview,
      },
    );

    return { message, conversationId: conversation.id };
  }

  async markMemberRead(member: { userId: string; email: string }) {
    const sub = await this.requireActiveLinkedSubscription(member);
    const conversation = await this.ensureConversation(sub.id, member.userId);
    const now = new Date();
    await this.db
      .update(coachConversations)
      .set({ memberLastReadAt: now })
      .where(eq(coachConversations.id, conversation.id));

    await this.fanout.toCoaches('chat.read', {
      type: 'chat.read',
      conversationId: conversation.id,
      subscriptionId: sub.id,
      readerRole: 'member',
      readAt: now.toISOString(),
    });

    return { ok: true as const, readAt: now.toISOString() };
  }

  async inbox(limit = 50) {
    const rows = await this.db
      .select()
      .from(coachConversations)
      .orderBy(desc(coachConversations.lastMessageAt), desc(coachConversations.createdAt))
      .limit(limit);

    const items = [];
    for (const row of rows) {
      const [sub] = await this.db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.id, row.subscriptionId))
        .limit(1);
      const [last] = await this.db
        .select()
        .from(coachMessages)
        .where(eq(coachMessages.conversationId, row.id))
        .orderBy(desc(coachMessages.createdAt))
        .limit(1);
      const unread = await this.countUnreadForCoach(row);
      const fullName = await this.profileName(row.memberUserId);
      items.push({
        conversation: this.toConversation(row, unread),
        subscriptionId: row.subscriptionId,
        email: sub?.email ?? '',
        fullName,
        lastMessage: last ? this.toMessage(last) : null,
      });
    }
    return { conversations: items };
  }

  async getClientThread(subscriptionId: string, limit = DEFAULT_LIMIT) {
    const sub = await this.requireSubscription(subscriptionId);
    if (!sub.userId) {
      throw new BadRequestException('Client has not signed into the app yet');
    }
    const conversation = await this.ensureConversation(sub.id, sub.userId);
    const messages = await this.listMessages(conversation.id, { limit });
    const unread = await this.countUnreadForCoach(conversation);
    return {
      conversation: this.toConversation(conversation, unread),
      messages,
    };
  }

  async listClientMessages(
    subscriptionId: string,
    opts: { before?: string; limit?: number },
  ) {
    const sub = await this.requireSubscription(subscriptionId);
    if (!sub.userId) {
      throw new BadRequestException('Client has not signed into the app yet');
    }
    const conversation = await this.ensureConversation(sub.id, sub.userId);
    const messages = await this.listMessages(conversation.id, opts);
    return { conversationId: conversation.id, messages };
  }

  async sendCoachMessage(
    subscriptionId: string,
    coachEmail: string,
    input: { body?: string; imageUrl?: string },
  ) {
    const text = this.normalizeBody(input.body, { allowEmptyWithImage: Boolean(input.imageUrl) });
    const imageUrl = input.imageUrl?.trim() || null;
    if (!text && !imageUrl) throw new BadRequestException('Message required');

    const sub = await this.requireSubscription(subscriptionId);
    if (!sub.userId) {
      throw new BadRequestException('Client has not signed into the app yet');
    }
    const conversation = await this.ensureConversation(sub.id, sub.userId);
    const message = await this.insertMessage({
      conversationId: conversation.id,
      senderRole: 'coach',
      senderUserId: null,
      senderCoachEmail: coachEmail.trim().toLowerCase() || null,
      body: text || (imageUrl ? ' ' : ''),
      imageUrl,
    });

    const now = new Date(message.createdAt);
    await this.db
      .update(coachConversations)
      .set({ lastMessageAt: now, coachLastReadAt: now })
      .where(eq(coachConversations.id, conversation.id));

    const preview = this.preview(text || 'Photo');
    await this.fanout.toMember(
      sub.userId,
      'chat.message',
      {
        type: 'chat.message',
        conversationId: conversation.id,
        subscriptionId: sub.id,
        memberUserId: sub.userId,
        messageId: message.id,
        senderRole: 'coach',
        body: message.body,
        imageUrl: message.imageUrl ?? '',
        createdAt: message.createdAt,
        route: '/ai',
      },
      {
        title: 'Coach',
        body: preview,
      },
    );

    return { message, conversationId: conversation.id };
  }

  async markCoachRead(subscriptionId: string) {
    const sub = await this.requireSubscription(subscriptionId);
    if (!sub.userId) {
      throw new BadRequestException('Client has not signed into the app yet');
    }
    const conversation = await this.ensureConversation(sub.id, sub.userId);
    const now = new Date();
    await this.db
      .update(coachConversations)
      .set({ coachLastReadAt: now })
      .where(eq(coachConversations.id, conversation.id));

    await this.fanout.toMember(sub.userId, 'chat.read', {
      type: 'chat.read',
      conversationId: conversation.id,
      subscriptionId: sub.id,
      readerRole: 'coach',
      readAt: now.toISOString(),
    });

    return { ok: true as const, readAt: now.toISOString() };
  }

  private async ensureConversation(subscriptionId: string, memberUserId: string) {
    const [existing] = await this.db
      .select()
      .from(coachConversations)
      .where(eq(coachConversations.subscriptionId, subscriptionId))
      .limit(1);
    if (existing) {
      if (existing.memberUserId !== memberUserId) {
        const [updated] = await this.db
          .update(coachConversations)
          .set({ memberUserId })
          .where(eq(coachConversations.id, existing.id))
          .returning();
        return updated ?? existing;
      }
      return existing;
    }

    const [created] = await this.db
      .insert(coachConversations)
      .values({
        subscriptionId,
        memberUserId,
        lastMessageAt: null,
        memberLastReadAt: null,
        coachLastReadAt: null,
      })
      .returning();
    if (!created) throw new BadRequestException('Could not open conversation');
    return created;
  }

  private async listMessages(
    conversationId: string,
    opts: { before?: string; limit?: number },
  ) {
    const limit = Math.min(100, Math.max(1, opts.limit ?? DEFAULT_LIMIT));
    const before = opts.before?.trim();
    let beforeDate: Date | null = null;
    if (before) {
      const parsed = new Date(before);
      if (!Number.isFinite(parsed.getTime())) {
        throw new BadRequestException('Invalid before cursor');
      }
      beforeDate = parsed;
    }

    const rows = await this.db
      .select()
      .from(coachMessages)
      .where(
        beforeDate
          ? and(
              eq(coachMessages.conversationId, conversationId),
              lt(coachMessages.createdAt, beforeDate),
            )
          : eq(coachMessages.conversationId, conversationId),
      )
      .orderBy(desc(coachMessages.createdAt))
      .limit(limit);

    return rows.map((row) => this.toMessage(row)).reverse();
  }

  private async insertMessage(input: {
    conversationId: string;
    senderRole: 'member' | 'coach';
    senderUserId: string | null;
    senderCoachEmail: string | null;
    body: string;
    imageUrl: string | null;
  }) {
    const [row] = await this.db
      .insert(coachMessages)
      .values({
        conversationId: input.conversationId,
        senderRole: input.senderRole,
        senderUserId: input.senderUserId,
        senderCoachEmail: input.senderCoachEmail,
        body: input.body,
        imageUrl: input.imageUrl,
      })
      .returning();
    if (!row) throw new BadRequestException('Could not send message');
    return this.toMessage(row);
  }

  private async countUnreadForCoach(conversation: typeof coachConversations.$inferSelect) {
    const since = conversation.coachLastReadAt;
    if (!since) {
      const [countRow] = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(coachMessages)
        .where(
          and(
            eq(coachMessages.conversationId, conversation.id),
            eq(coachMessages.senderRole, 'member'),
          ),
        );
      return Number(countRow?.count ?? 0);
    }
    const [countRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(coachMessages)
      .where(
        and(
          eq(coachMessages.conversationId, conversation.id),
          eq(coachMessages.senderRole, 'member'),
          gt(coachMessages.createdAt, since),
        ),
      );
    return Number(countRow?.count ?? 0);
  }

  private async countUnreadForMember(conversation: typeof coachConversations.$inferSelect) {
    const since = conversation.memberLastReadAt;
    if (!since) {
      const [countRow] = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(coachMessages)
        .where(
          and(
            eq(coachMessages.conversationId, conversation.id),
            eq(coachMessages.senderRole, 'coach'),
          ),
        );
      return Number(countRow?.count ?? 0);
    }
    const [countRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(coachMessages)
      .where(
        and(
          eq(coachMessages.conversationId, conversation.id),
          eq(coachMessages.senderRole, 'coach'),
          gt(coachMessages.createdAt, since),
        ),
      );
    return Number(countRow?.count ?? 0);
  }

  private async requireActiveLinkedSubscription(member: {
    userId: string;
    email: string;
  }) {
    const email = member.email.trim().toLowerCase();
    let rows = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, member.userId))
      .orderBy(desc(subscriptions.updatedAt))
      .limit(10);

    if (rows.length === 0 && email) {
      rows = await this.db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.email, email))
        .orderBy(desc(subscriptions.updatedAt))
        .limit(10);
    }

    const now = Date.now();
    const live = rows.find((row) => {
      if (row.status !== 'active') return false;
      if (row.expiresAt && new Date(row.expiresAt).getTime() <= now) return false;
      return true;
    });
    if (!live) throw new BadRequestException('Active subscription required');
    if (!live.userId) {
      const [linked] = await this.db
        .update(subscriptions)
        .set({ userId: member.userId, updatedAt: new Date() })
        .where(eq(subscriptions.id, live.id))
        .returning();
      return linked ?? { ...live, userId: member.userId };
    }
    return live;
  }

  private async requireSubscription(subscriptionId: string) {
    const [row] = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId))
      .limit(1);
    if (!row) throw new NotFoundException('Client not found');
    return row;
  }

  private async profileName(userId: string) {
    const [row] = await this.db
      .select({ fullName: profiles.fullName })
      .from(profiles)
      .where(eq(profiles.id, userId))
      .limit(1);
    return row?.fullName?.trim() || null;
  }

  private normalizeBody(body?: string, opts?: { allowEmptyWithImage?: boolean }) {
    const text = (body ?? '').trim();
    if (!text) {
      if (opts?.allowEmptyWithImage) return '';
      throw new BadRequestException('Message required');
    }
    if (text.length > BODY_MAX) {
      throw new BadRequestException(`Message must be under ${BODY_MAX} characters`);
    }
    return text;
  }

  private preview(text: string) {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (cleaned.length <= 80) return cleaned || 'New message';
    return `${cleaned.slice(0, 77)}...`;
  }

  private toMessage(row: typeof coachMessages.$inferSelect): PublicChatMessage {
    return {
      id: row.id,
      conversationId: row.conversationId,
      senderRole: row.senderRole === 'coach' ? 'coach' : 'member',
      senderUserId: row.senderUserId,
      senderCoachEmail: row.senderCoachEmail,
      body: row.body,
      imageUrl: row.imageUrl,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toConversation(
    row: typeof coachConversations.$inferSelect,
    unreadCount: number,
  ): PublicConversation {
    return {
      id: row.id,
      subscriptionId: row.subscriptionId,
      memberUserId: row.memberUserId,
      lastMessageAt: row.lastMessageAt ? row.lastMessageAt.toISOString() : null,
      memberLastReadAt: row.memberLastReadAt ? row.memberLastReadAt.toISOString() : null,
      coachLastReadAt: row.coachLastReadAt ? row.coachLastReadAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      unreadCount,
    };
  }
}
