import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, gte, inArray, lt } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DB } from '../db/db.module.js';
import {
  coachAvailability,
  coachTimeOff,
  profiles,
  sessionBookings,
} from '../db/schema.js';
import { FcmService } from '../notifications/fcm.service.js';
import { SubscriptionService } from '../subscriptions/subscription.service.js';

type Db = PostgresJsDatabase<typeof import('../db/schema.js')>;

const SLOT_MINUTES = 60;
const HORIZON_DAYS = 14;
const IST_MS = (5 * 60 + 30) * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

type WindowInput = {
  weekday: number;
  startMinute: number;
  endMinute: number;
};

type TimeOffInput = {
  startsAt: string;
  endsAt: string;
};

type IstWall = {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
  second: number;
};

@Injectable()
export class SessionsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly subscriptions: SubscriptionService,
    private readonly fcm: FcmService,
  ) {}

  async getAvailability() {
    const [windows, timeOff] = await Promise.all([
      this.db.select().from(coachAvailability).orderBy(asc(coachAvailability.weekday), asc(coachAvailability.startMinute)),
      this.db.select().from(coachTimeOff).orderBy(asc(coachTimeOff.startsAt)),
    ]);
    return {
      windows: windows.map((row) => ({
        id: row.id,
        weekday: row.weekday,
        startMinute: row.startMinute,
        endMinute: row.endMinute,
      })),
      timeOff: timeOff.map((row) => ({
        id: row.id,
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt.toISOString(),
      })),
    };
  }

  async replaceAvailability(body: { windows?: unknown; timeOff?: unknown }) {
    const windows = this.parseWindows(body.windows);
    const timeOff = this.parseTimeOff(body.timeOff);
    await this.db.transaction(async (tx) => {
      await tx.delete(coachAvailability);
      if (windows.length) {
        await tx.insert(coachAvailability).values(windows);
      }
      await tx.delete(coachTimeOff);
      if (timeOff.length) {
        await tx.insert(coachTimeOff).values(timeOff);
      }
    });
    return this.getAvailability();
  }

  async openSlots() {
    const now = new Date();
    const horizon = new Date(now.getTime() + HORIZON_DAYS * DAY_MS);
    const [windows, blocks, taken] = await Promise.all([
      this.db.select().from(coachAvailability),
      this.db.select().from(coachTimeOff),
      this.db
        .select({ startsAt: sessionBookings.startsAt })
        .from(sessionBookings)
        .where(
          and(
            eq(sessionBookings.status, 'booked'),
            gte(sessionBookings.startsAt, now),
            lt(sessionBookings.startsAt, horizon),
          ),
        ),
    ]);
    const takenMs = new Set(taken.map((row) => row.startsAt.getTime()));
    const slots: { startsAt: string; endsAt: string }[] = [];
    const today = istWall(now);
    let cursor = fromIst(today.year, today.month, today.day, 0, 0);
    for (let day = 0; day < HORIZON_DAYS; day += 1) {
      const wall = istWall(cursor);
      const dayWindows = windows.filter((row) => row.weekday === wall.weekday);
      for (const window of dayWindows) {
        for (
          let minute = window.startMinute;
          minute + SLOT_MINUTES <= window.endMinute;
          minute += SLOT_MINUTES
        ) {
          const start = fromIst(wall.year, wall.month, wall.day, 0, minute);
          const end = new Date(start.getTime() + SLOT_MINUTES * 60 * 1000);
          if (start.getTime() <= now.getTime()) continue;
          if (start.getTime() > horizon.getTime()) continue;
          if (takenMs.has(start.getTime())) continue;
          if (overlapsAny(start, end, blocks)) continue;
          slots.push({ startsAt: start.toISOString(), endsAt: end.toISOString() });
        }
      }
      cursor = new Date(cursor.getTime() + DAY_MS);
    }
    return { slots };
  }

  async listBookings(filter?: { subscriptionId?: string; upcomingOnly?: boolean }) {
    const rows = await this.db
      .select()
      .from(sessionBookings)
      .orderBy(asc(sessionBookings.startsAt));
    const now = Date.now();
    const filtered = rows.filter((row) => {
      if (filter?.subscriptionId && row.subscriptionId !== filter.subscriptionId) return false;
      if (filter?.upcomingOnly && (row.status !== 'booked' || row.endsAt.getTime() <= now)) {
        return false;
      }
      return true;
    });
    const names = await this.namesFor(filtered.map((row) => row.userId));
    return {
      sessions: filtered.map((row) => this.toPublic(row, names.get(row.userId ?? '') ?? null)),
    };
  }

  async memberSessions(input: { userId: string; email: string }) {
    const plan = await this.subscriptions.getPlanForIdentity(input);
    const subscriptionId = plan.subscription?.id;
    if (!subscriptionId) return { sessions: [] };
    return this.listBookings({ subscriptionId });
  }

  async bookAsMember(input: { userId: string; email: string; startsAt?: string }) {
    const plan = await this.subscriptions.getPlanForIdentity(input);
    if (!plan.active || !plan.subscription?.id) {
      throw new BadRequestException('An active plan is required to book a session');
    }
    const booking = await this.createBooking({
      subscriptionId: plan.subscription.id,
      userId: plan.subscription.userId ?? input.userId,
      email: plan.subscription.email || input.email,
      startsAt: input.startsAt,
      bookedBy: 'member',
    });
    const label = formatIst(new Date(booking.startsAt));
    await this.safePush(() =>
      this.fcm.sendToCoaches({
        title: 'Session booked',
        body: `${booking.fullName || booking.email} booked ${label}`,
        data: { type: 'session', route: '/availability' },
      }),
    );
    return { session: booking };
  }

  async bookAsCoach(subscriptionId: string, startsAt?: string) {
    const detail = await this.subscriptions.getClientDetail(subscriptionId);
    if (!detail?.subscription) throw new NotFoundException('Client not found');
    const sub = detail.subscription;
    if (sub.status !== 'active') {
      throw new BadRequestException('This client does not have an active plan');
    }
    const booking = await this.createBooking({
      subscriptionId: sub.id,
      userId: sub.userId,
      email: sub.email,
      startsAt,
      bookedBy: 'coach',
    });
    const label = formatIst(new Date(booking.startsAt));
    if (booking.userId) {
      await this.safePush(() =>
        this.fcm.sendToMember(booking.userId!, {
          title: 'Session booked',
          body: `Your coach booked you for ${label}`,
          data: { type: 'session', route: '/sessions' },
        }),
      );
    }
    return { session: booking };
  }

  async cancelAsMember(id: string, input: { userId: string; email: string }) {
    const plan = await this.subscriptions.getPlanForIdentity(input);
    if (!plan.subscription?.id) throw new NotFoundException('Session not found');
    const booking = await this.cancelBooking(id, plan.subscription.id);
    const label = formatIst(new Date(booking.startsAt));
    await this.safePush(() =>
      this.fcm.sendToCoaches({
        title: 'Session cancelled',
        body: `${booking.fullName || booking.email} cancelled ${label}`,
        data: { type: 'session', route: '/availability' },
      }),
    );
    return { session: booking };
  }

  async cancelAsCoach(id: string) {
    const booking = await this.cancelBooking(id);
    const label = formatIst(new Date(booking.startsAt));
    if (booking.userId) {
      await this.safePush(() =>
        this.fcm.sendToMember(booking.userId!, {
          title: 'Session cancelled',
          body: `Your coach cancelled ${label}`,
          data: { type: 'session', route: '/sessions' },
        }),
      );
    }
    return { session: booking };
  }

  private async createBooking(input: {
    subscriptionId: string;
    userId: string | null;
    email: string;
    startsAt?: string;
    bookedBy: 'member' | 'coach';
  }) {
    const start = this.parseSlotStart(input.startsAt);
    const end = new Date(start.getTime() + SLOT_MINUTES * 60 * 1000);
    await this.assertBookable(start, end);
    try {
      const [row] = await this.db.transaction(async (tx) => {
        const clash = await tx
          .select({ id: sessionBookings.id })
          .from(sessionBookings)
          .where(
            and(eq(sessionBookings.status, 'booked'), eq(sessionBookings.startsAt, start)),
          )
          .limit(1);
        if (clash.length) {
          throw new BadRequestException('That time is already booked');
        }
        return tx
          .insert(sessionBookings)
          .values({
            subscriptionId: input.subscriptionId,
            userId: input.userId,
            email: input.email,
            startsAt: start,
            endsAt: end,
            status: 'booked',
            bookedBy: input.bookedBy,
          })
          .returning();
      });
      const names = await this.namesFor([row.userId]);
      return this.toPublic(row, names.get(row.userId ?? '') ?? null);
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('session_bookings_start_booked_uidx') || message.includes('duplicate key')) {
        throw new BadRequestException('That time is already booked');
      }
      throw error;
    }
  }

  private async cancelBooking(id: string, subscriptionId?: string) {
    const [row] = await this.db
      .select()
      .from(sessionBookings)
      .where(eq(sessionBookings.id, id))
      .limit(1);
    if (!row || (subscriptionId && row.subscriptionId !== subscriptionId)) {
      throw new NotFoundException('Session not found');
    }
    if (row.status !== 'booked') {
      throw new BadRequestException('This session is already cancelled');
    }
    if (row.endsAt.getTime() <= Date.now()) {
      throw new BadRequestException('This session has already ended');
    }
    const [updated] = await this.db
      .update(sessionBookings)
      .set({ status: 'cancelled' })
      .where(eq(sessionBookings.id, id))
      .returning();
    const names = await this.namesFor([updated.userId]);
    return this.toPublic(updated, names.get(updated.userId ?? '') ?? null);
  }

  private async assertBookable(start: Date, end: Date) {
    const now = Date.now();
    if (start.getTime() <= now) {
      throw new BadRequestException('That time is in the past');
    }
    if (start.getTime() > now + HORIZON_DAYS * DAY_MS) {
      throw new BadRequestException('Sessions can only be booked 14 days ahead');
    }
    const wall = istWall(start);
    if (wall.minute !== 0 || wall.second !== 0) {
      throw new BadRequestException('Sessions start on the hour');
    }
    const minute = wall.hour * 60 + wall.minute;
    const windows = await this.db
      .select()
      .from(coachAvailability)
      .where(eq(coachAvailability.weekday, wall.weekday));
    const inside = windows.some(
      (row) => minute >= row.startMinute && minute + SLOT_MINUTES <= row.endMinute,
    );
    if (!inside) {
      throw new BadRequestException('That time is outside the coach’s hours');
    }
    const blocks = await this.db.select().from(coachTimeOff);
    if (overlapsAny(start, end, blocks)) {
      throw new BadRequestException('The coach is unavailable then');
    }
  }

  private parseSlotStart(raw?: string) {
    if (!raw || Number.isNaN(Date.parse(raw))) {
      throw new BadRequestException('Choose a session time');
    }
    return new Date(raw);
  }

  private parseWindows(raw: unknown): WindowInput[] {
    if (!Array.isArray(raw)) throw new BadRequestException('Weekly hours are required');
    const windows: WindowInput[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') {
        throw new BadRequestException('A weekly hour is invalid');
      }
      const row = item as Record<string, unknown>;
      const weekday = Number(row.weekday);
      const startMinute = Number(row.startMinute);
      const endMinute = Number(row.endMinute);
      if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
        throw new BadRequestException('Weekday must be 0–6');
      }
      if (
        !Number.isInteger(startMinute) ||
        !Number.isInteger(endMinute) ||
        startMinute < 0 ||
        endMinute > 24 * 60 ||
        startMinute >= endMinute ||
        startMinute % SLOT_MINUTES !== 0 ||
        endMinute % SLOT_MINUTES !== 0
      ) {
        throw new BadRequestException('Hours must start and end on the hour');
      }
      windows.push({ weekday, startMinute, endMinute });
    }
    for (let i = 0; i < windows.length; i += 1) {
      for (let j = i + 1; j < windows.length; j += 1) {
        const a = windows[i];
        const b = windows[j];
        if (a.weekday === b.weekday && a.startMinute < b.endMinute && b.startMinute < a.endMinute) {
          throw new BadRequestException('Weekly hours overlap');
        }
      }
    }
    return windows;
  }

  private parseTimeOff(raw: unknown): { startsAt: Date; endsAt: Date }[] {
    if (raw == null) return [];
    if (!Array.isArray(raw)) throw new BadRequestException('Time off is invalid');
    return raw.map((item) => {
      if (!item || typeof item !== 'object') {
        throw new BadRequestException('A blocked range is invalid');
      }
      const row = item as Record<string, unknown>;
      const startsAt = new Date(String(row.startsAt ?? ''));
      const endsAt = new Date(String(row.endsAt ?? ''));
      if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || startsAt >= endsAt) {
        throw new BadRequestException('A blocked range needs a start before the end');
      }
      return { startsAt, endsAt };
    });
  }

  private async namesFor(userIds: Array<string | null>) {
    const ids = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
    const map = new Map<string, string | null>();
    if (!ids.length) return map;
    const rows = await this.db
      .select({ id: profiles.id, fullName: profiles.fullName })
      .from(profiles)
      .where(inArray(profiles.id, ids));
    for (const row of rows) map.set(row.id, row.fullName);
    return map;
  }

  private toPublic(
    row: typeof sessionBookings.$inferSelect,
    fullName: string | null,
  ) {
    return {
      id: row.id,
      subscriptionId: row.subscriptionId,
      userId: row.userId,
      email: row.email,
      fullName,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      status: row.status,
      bookedBy: row.bookedBy,
    };
  }

  private async safePush(send: () => Promise<void>) {
    try {
      await send();
    } catch {
      // A missing push token should not undo the booking.
    }
  }
}

function istWall(instant: Date): IstWall {
  const shifted = new Date(instant.getTime() + IST_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

function fromIst(year: number, month: number, day: number, hour: number, minute: number) {
  return new Date(Date.UTC(year, month, day, hour, minute) - IST_MS);
}

function overlapsAny(
  start: Date,
  end: Date,
  blocks: { startsAt: Date; endsAt: Date }[],
) {
  return blocks.some((block) => start < block.endsAt && end > block.startsAt);
}

function formatIst(instant: Date) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(instant);
}
