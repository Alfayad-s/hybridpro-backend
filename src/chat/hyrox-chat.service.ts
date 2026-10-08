import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { and, desc, eq, gt, ne, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DB } from '../db/db.module.js';
import {
  hyroxMessages,
  hyroxReads,
  memberAccounts,
  profiles,
  subscriptions,
} from '../db/schema.js';
import { RealtimeFanoutService } from '../realtime/realtime-fanout.service.js';

type Db = PostgresJsDatabase<typeof import('../db/schema.js')>;

const ROOM_ID = 'hyrox';
const BODY_MAX = 4000;
const DEFAULT_LIMIT = 40;

export type HyroxChatMessage = {
  id: string;
  conversationId: string;
  senderRole: 'member' | 'coach';
  senderUserId: string | null;
  senderName: string;
  senderCoachEmail: string | null;
  body: string;
  imageUrl: string | null;
  createdAt: string;
};

@Injectable()
export class HyroxChatService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly fanout: RealtimeFanoutService,
  ) {}

  async getMemberThread(member: { userId: string; email: string }, limit = DEFAULT_LIMIT) {
    await this.requireHyroxMember(member);
    const messages = await this.listMessages(limit);
    const unreadCount = await this.unreadFor(member.userId);
    const members = await this.listMembers();
    return {
      conversation: this.conversation(member.userId, unreadCount),
      messages,
      members,
    };
  }

  async sendMemberMessage(
    member: { userId: string; email: string },
    input: { body?: string; imageUrl?: string },
  ) {
    await this.requireHyroxMember(member);
    const message = await this.insert({
      senderRole: 'member',
      senderUserId: member.userId,
      senderName: await this.memberFirstName(member.userId),
      senderCoachEmail: null,
      body: input.body,
      imageUrl: input.imageUrl,
    });
    await this.markRead(member.userId);
    await this.fanoutMessage(message, member.userId);
    return { message };
  }

  async markMemberRead(member: { userId: string; email: string }) {
    await this.requireHyroxMember(member);
    await this.markRead(member.userId);
    return { ok: true };
  }

  async getCoachThread(limit = DEFAULT_LIMIT) {
    const messages = await this.listMessages(limit);
    const unreadCount = await this.unreadFor('coach');
    return {
      conversation: this.conversation('coach', unreadCount),
      messages,
    };
  }

  async sendCoachMessage(coachEmail: string, input: { body?: string; imageUrl?: string }) {
    const message = await this.insert({
      senderRole: 'coach',
      senderUserId: null,
      senderName: 'Coach',
      senderCoachEmail: coachEmail.trim().toLowerCase() || null,
      body: input.body,
      imageUrl: input.imageUrl,
    });
    await this.markRead('coach');
    await this.fanoutMessage(message, null);
    return { message };
  }

  async markCoachRead() {
    await this.markRead('coach');
    return { ok: true };
  }

  private async listMembers() {
    const rows = await this.db
      .select({
        userId: subscriptions.userId,
        expiresAt: subscriptions.expiresAt,
        profileName: profiles.fullName,
        profileAvatar: profiles.avatarUrl,
        accountName: memberAccounts.fullName,
        accountAvatar: memberAccounts.avatarUrl,
      })
      .from(subscriptions)
      .leftJoin(profiles, eq(profiles.id, subscriptions.userId))
      .leftJoin(memberAccounts, eq(memberAccounts.id, subscriptions.userId))
      .where(and(eq(subscriptions.planId, 'hyrox'), eq(subscriptions.status, 'active')));

    const seen = new Set<string>();
    const members: { userId: string; name: string; avatarUrl: string | null }[] = [];
    for (const row of rows) {
      if (!row.userId || seen.has(row.userId)) continue;
      if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) continue;
      seen.add(row.userId);
      const name = (row.profileName || row.accountName || '').trim() || 'Member';
      const avatar = (row.profileAvatar || row.accountAvatar || '').trim() || null;
      members.push({ userId: row.userId, name, avatarUrl: avatar });
    }
    members.sort((a, b) => a.name.localeCompare(b.name));
    return members;
  }

  private conversation(memberUserId: string, unreadCount: number) {
    return {
      id: ROOM_ID,
      subscriptionId: ROOM_ID,
      memberUserId,
      lastMessageAt: null as string | null,
      memberLastReadAt: null as string | null,
      coachLastReadAt: null as string | null,
      createdAt: new Date(0).toISOString(),
      unreadCount,
      title: 'Hyrox group',
    };
  }

  private async listMessages(limit: number) {
    const take = Math.min(Math.max(limit || DEFAULT_LIMIT, 1), 100);
    const rows = await this.db
      .select()
      .from(hyroxMessages)
      .orderBy(desc(hyroxMessages.createdAt))
      .limit(take);
    return rows.reverse().map((row) => this.toMessage(row));
  }

  private async insert(input: {
    senderRole: 'member' | 'coach';
    senderUserId: string | null;
    senderName: string;
    senderCoachEmail: string | null;
    body?: string;
    imageUrl?: string;
  }) {
    const imageUrl = input.imageUrl?.trim() || null;
    const text = (input.body ?? '').trim().slice(0, BODY_MAX);
    if (!text && !imageUrl) throw new BadRequestException('Message required');
    const [row] = await this.db
      .insert(hyroxMessages)
      .values({
        senderRole: input.senderRole,
        senderUserId: input.senderUserId,
        senderName: input.senderName || 'Member',
        senderCoachEmail: input.senderCoachEmail,
        body: text || ' ',
        imageUrl,
      })
      .returning();
    if (!row) throw new BadRequestException('Message was not saved');
    return this.toMessage(row);
  }

  private toMessage(row: typeof hyroxMessages.$inferSelect): HyroxChatMessage {
    return {
      id: row.id,
      conversationId: ROOM_ID,
      senderRole: row.senderRole === 'coach' ? 'coach' : 'member',
      senderUserId: row.senderUserId,
      senderName: row.senderName,
      senderCoachEmail: row.senderCoachEmail,
      body: row.body,
      imageUrl: row.imageUrl,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async markRead(userId: string) {
    const now = new Date();
    await this.db
      .insert(hyroxReads)
      .values({ userId, lastReadAt: now })
      .onConflictDoUpdate({
        target: hyroxReads.userId,
        set: { lastReadAt: now },
      });
  }

  private async unreadFor(userId: string) {
    const read = (
      await this.db.select().from(hyroxReads).where(eq(hyroxReads.userId, userId)).limit(1)
    )[0];
    const since = read?.lastReadAt ?? new Date(0);
    const where =
      userId === 'coach'
        ? and(eq(hyroxMessages.senderRole, 'member'), gt(hyroxMessages.createdAt, since))
        : and(
            gt(hyroxMessages.createdAt, since),
            or(eq(hyroxMessages.senderRole, 'coach'), ne(hyroxMessages.senderUserId, userId)),
          );
    const [countRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(hyroxMessages)
      .where(where);
    return Number(countRow?.count ?? 0);
  }

  private async requireHyroxMember(member: { userId: string; email: string }) {
    const rows = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, member.userId))
      .orderBy(desc(subscriptions.updatedAt));
    const live = rows.find((row) => {
      if (row.planId !== 'hyrox' || row.status !== 'active') return false;
      if (!row.expiresAt) return true;
      return row.expiresAt.getTime() > Date.now();
    });
    if (!live) throw new ForbiddenException('Hyrox group is for an active Hyrox plan');
    return live;
  }

  private async memberFirstName(userId: string) {
    const profile = (
      await this.db.select().from(profiles).where(eq(profiles.id, userId)).limit(1)
    )[0];
    const account = profile
      ? null
      : (
          await this.db
            .select()
            .from(memberAccounts)
            .where(eq(memberAccounts.id, userId))
            .limit(1)
        )[0];
    const full = (profile?.fullName || account?.fullName || '').trim();
    const first = full.split(/\s+/)[0];
    return first || 'Member';
  }

  private async fanoutMessage(message: HyroxChatMessage, senderUserId: string | null) {
    const payload = {
      type: 'hyrox.chat',
      conversationId: ROOM_ID,
      messageId: message.id,
      senderRole: message.senderRole,
      senderUserId: message.senderUserId ?? '',
      senderName: message.senderName,
      body: message.body,
      imageUrl: message.imageUrl ?? '',
      createdAt: message.createdAt,
    };
    const members = await this.db
      .select({ userId: subscriptions.userId })
      .from(subscriptions)
      .where(and(eq(subscriptions.planId, 'hyrox'), eq(subscriptions.status, 'active')));
    const seen = new Set<string>();
    for (const row of members) {
      if (!row.userId || seen.has(row.userId) || row.userId === senderUserId) continue;
      seen.add(row.userId);
      await this.fanout.toMember(row.userId, 'hyrox.chat', payload);
    }
    await this.fanout.toCoaches('hyrox.chat', payload, {
      title: 'Hyrox group',
      body: `${message.senderName}: ${message.body.trim().slice(0, 80) || 'Photo'}`,
    });
  }
}
