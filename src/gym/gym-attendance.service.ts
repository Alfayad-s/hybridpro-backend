import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DB } from '../db/db.module.js';
import { gymSessions, profiles, subscriptions } from '../db/schema.js';
import { RealtimeFanoutService } from '../realtime/realtime-fanout.service.js';

type Db = PostgresJsDatabase<typeof import('../db/schema.js')>;

export type PublicGymSession = {
  sessionId: string;
  subscriptionId: string;
  userId: string;
  email: string;
  fullName: string | null;
  checkedInAt: string;
  checkedOutAt: string | null;
  status: 'open' | 'closed';
};

@Injectable()
export class GymAttendanceService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly fanout: RealtimeFanoutService,
  ) {}

  async statusForMember(userId: string) {
    const [open] = await this.db
      .select()
      .from(gymSessions)
      .where(and(eq(gymSessions.userId, userId), eq(gymSessions.status, 'open')))
      .limit(1);

    if (!open) return { status: 'closed' as const, session: null };

    const meta = await this.sessionMeta(open.subscriptionId, userId);
    return {
      status: 'open' as const,
      session: this.toPublic(open, meta),
    };
  }

  async checkIn(member: { userId: string; email: string; fullName?: string | null }) {
    const subscription = await this.requireActiveSubscription(member);
    const [existing] = await this.db
      .select()
      .from(gymSessions)
      .where(and(eq(gymSessions.userId, member.userId), eq(gymSessions.status, 'open')))
      .limit(1);
    if (existing) {
      throw new BadRequestException('Already checked in');
    }

    const now = new Date();
    const [row] = await this.db
      .insert(gymSessions)
      .values({
        subscriptionId: subscription.id,
        userId: member.userId,
        checkedInAt: now,
        checkedOutAt: null,
        status: 'open',
      })
      .returning();
    if (!row) throw new BadRequestException('Could not check in');

    const fullName = (await this.profileName(member.userId)) || member.fullName || null;
    const publicSession = this.toPublic(row, {
      email: subscription.email,
      fullName,
    });

    await this.fanout.toCoaches(
      'gym.checked_in',
      {
        type: 'gym.checked_in',
        sessionId: publicSession.sessionId,
        subscriptionId: publicSession.subscriptionId,
        userId: publicSession.userId,
        email: publicSession.email,
        fullName: publicSession.fullName ?? '',
        checkedInAt: publicSession.checkedInAt,
        route: `/clients/${publicSession.subscriptionId}`,
      },
      {
        title: 'Member checked in',
        body: `${fullName || publicSession.email} is at the gym`,
      },
    );

    return { status: 'open' as const, session: publicSession };
  }

  async checkOut(member: { userId: string; email: string; fullName?: string | null }) {
    const [open] = await this.db
      .select()
      .from(gymSessions)
      .where(and(eq(gymSessions.userId, member.userId), eq(gymSessions.status, 'open')))
      .limit(1);
    if (!open) throw new BadRequestException('Not checked in');

    const now = new Date();
    const [row] = await this.db
      .update(gymSessions)
      .set({ status: 'closed', checkedOutAt: now })
      .where(eq(gymSessions.id, open.id))
      .returning();
    if (!row) throw new BadRequestException('Could not check out');

    const [sub] = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, row.subscriptionId))
      .limit(1);
    const fullName = (await this.profileName(member.userId)) || member.fullName || null;
    const publicSession = this.toPublic(row, {
      email: sub?.email || member.email,
      fullName,
    });

    await this.fanout.toCoaches(
      'gym.checked_out',
      {
        type: 'gym.checked_out',
        sessionId: publicSession.sessionId,
        subscriptionId: publicSession.subscriptionId,
        userId: publicSession.userId,
        email: publicSession.email,
        fullName: publicSession.fullName ?? '',
        checkedInAt: publicSession.checkedInAt,
        checkedOutAt: publicSession.checkedOutAt ?? '',
        route: `/clients/${publicSession.subscriptionId}`,
      },
      {
        title: 'Member checked out',
        body: `${fullName || publicSession.email} left the gym`,
      },
    );

    return { status: 'closed' as const, session: publicSession };
  }

  async listActive() {
    const rows = await this.db
      .select()
      .from(gymSessions)
      .where(eq(gymSessions.status, 'open'))
      .orderBy(desc(gymSessions.checkedInAt))
      .limit(200);

    const result: PublicGymSession[] = [];
    for (const row of rows) {
      const meta = await this.sessionMeta(row.subscriptionId, row.userId);
      result.push(this.toPublic(row, meta));
    }
    return { sessions: result };
  }

  async listForClient(subscriptionId: string) {
    const [sub] = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId))
      .limit(1);
    if (!sub) throw new NotFoundException('Client not found');

    const rows = await this.db
      .select()
      .from(gymSessions)
      .where(eq(gymSessions.subscriptionId, subscriptionId))
      .orderBy(desc(gymSessions.checkedInAt))
      .limit(50);

    const fullName = sub.userId ? await this.profileName(sub.userId) : null;
    return {
      sessions: rows.map((row) =>
        this.toPublic(row, { email: sub.email, fullName }),
      ),
    };
  }

  private async requireActiveSubscription(member: { userId: string; email: string }) {
    const email = member.email.trim().toLowerCase();
    const rows = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, member.userId))
      .orderBy(desc(subscriptions.updatedAt))
      .limit(10);

    let candidates = rows;
    if (candidates.length === 0 && email) {
      candidates = await this.db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.email, email))
        .orderBy(desc(subscriptions.updatedAt))
        .limit(10);
    }

    const now = Date.now();
    const live = candidates.find((row) => {
      if (row.status !== 'active') return false;
      if (row.expiresAt && new Date(row.expiresAt).getTime() <= now) return false;
      return true;
    });
    if (!live) throw new BadRequestException('Active subscription required');
    return live;
  }

  private async profileName(userId: string) {
    const [row] = await this.db
      .select({ fullName: profiles.fullName })
      .from(profiles)
      .where(eq(profiles.id, userId))
      .limit(1);
    return row?.fullName?.trim() || null;
  }

  private async sessionMeta(subscriptionId: string, userId: string) {
    const [sub] = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId))
      .limit(1);
    const fullName = await this.profileName(userId);
    return { email: sub?.email || '', fullName };
  }

  private toPublic(
    row: typeof gymSessions.$inferSelect,
    meta: { email: string; fullName: string | null },
  ): PublicGymSession {
    return {
      sessionId: row.id,
      subscriptionId: row.subscriptionId,
      userId: row.userId,
      email: meta.email,
      fullName: meta.fullName,
      checkedInAt: row.checkedInAt.toISOString(),
      checkedOutAt: row.checkedOutAt ? row.checkedOutAt.toISOString() : null,
      status: row.status === 'open' ? 'open' : 'closed',
    };
  }
}
