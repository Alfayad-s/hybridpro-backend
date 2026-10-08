import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DB } from '../db/db.module.js';
import {
  engagementEvents,
  engagementPreferences,
  engagementSettings,
  gymSessions,
  memberRoutines,
  notificationLogs,
  notificationTemplates,
  subscriptions,
  userRewards,
} from '../db/schema.js';
import { FcmService } from '../notifications/fcm.service.js';
import { WorkoutService } from '../workout/workout.service.js';
import { claimOccurrence } from './dispatch.js';
import {
  DEFAULT_DAILY_LIMIT,
  DEFAULT_QUIET_END,
  DEFAULT_QUIET_START,
  evaluate,
  type CategoryPrefs,
  type EngagementDecision,
  type MealSlot,
  type MemberRoutine,
  type SentNotice,
} from './rules.js';
import { DEFAULT_TEMPLATES, NOTIFICATION_TYPES, type NotificationPriority, type NotificationType } from './templates.js';
import { buildDaySnapshot } from './snapshot.js';
import { localDateKey, minutesOfDay, zonedParts } from './time.js';

type Db = PostgresJsDatabase<typeof import('../db/schema.js')>;

const WEEKDAYS: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

type RoutinePatch = {
  timezone?: unknown;
  wakeMinutes?: unknown;
  gymMinutes?: unknown;
  breakfastMinutes?: unknown;
  lunchMinutes?: unknown;
  dinnerMinutes?: unknown;
  sleepMinutes?: unknown;
};

type PreferencePatch = {
  workout?: unknown;
  meals?: unknown;
  hydration?: unknown;
  sleep?: unknown;
  motivation?: unknown;
  streak?: unknown;
  quietStartMinutes?: unknown;
  quietEndMinutes?: unknown;
};

@Injectable()
export class EngagementService {
  private readonly logger = new Logger(EngagementService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly workouts: WorkoutService,
    private readonly fcm: FcmService,
  ) {}

  async today(userId: string, timezone?: string) {
    const now = new Date();
    const routine = await this.ensureRoutine(userId, timezone);
    const decision = await this.decide(userId, routine, now);
    const prefs = await this.readPrefs(userId);
    return toResponse(decision, routine, prefs);
  }

  async updateRoutine(userId: string, patch: Record<string, unknown>) {
    const now = new Date();
    const current = await this.ensureRoutine(userId);
    const next = applyRoutinePatch(current, patch);
    await this.db
      .insert(memberRoutines)
      .values({ userId, ...toRoutineRow(next), updatedAt: now })
      .onConflictDoUpdate({
        target: memberRoutines.userId,
        set: { ...toRoutineRow(next), updatedAt: now },
      });
    if (patch.gymMinutes !== undefined && next.gymMinutes !== current.gymMinutes) {
      const parts = zonedParts(now, next.timezone);
      await this.db.insert(engagementEvents).values({
        userId,
        type: 'GYM_TIME_SELECTED',
        localDate: localDateKey(parts),
        payload: JSON.stringify({ gymMinutes: next.gymMinutes }),
      });
    }
    const decision = await this.decide(userId, next, now);
    return toResponse(decision, next, await this.readPrefs(userId));
  }

  async updatePreferences(userId: string, patch: Record<string, unknown>) {
    const now = new Date();
    const current = await this.readPrefs(userId);
    const next = applyPreferencePatch(current, patch);
    await this.db
      .insert(engagementPreferences)
      .values({ userId, ...next, updatedAt: now })
      .onConflictDoUpdate({
        target: engagementPreferences.userId,
        set: { ...next, updatedAt: now },
      });
    const routine = await this.ensureRoutine(userId);
    const decision = await this.decide(userId, routine, now);
    return toResponse(decision, routine, next);
  }

  async skipMeal(userId: string, meal: unknown) {
    if (meal !== 'breakfast' && meal !== 'lunch' && meal !== 'dinner') {
      throw new BadRequestException('meal must be breakfast, lunch, or dinner');
    }
    const now = new Date();
    const routine = await this.ensureRoutine(userId);
    const date = localDateKey(zonedParts(now, routine.timezone));
    const existing = await this.db
      .select({ payload: engagementEvents.payload })
      .from(engagementEvents)
      .where(
        and(
          eq(engagementEvents.userId, userId),
          eq(engagementEvents.type, 'MEAL_SKIPPED'),
          eq(engagementEvents.localDate, date),
        ),
      );
    const already = skippedMeals(existing.map((row) => row.payload)).includes(meal);
    if (!already) {
      await this.db.insert(engagementEvents).values({
        userId,
        type: 'MEAL_SKIPPED',
        localDate: date,
        payload: JSON.stringify({ meal }),
      });
    }
    return this.today(userId);
  }

  async runTick(now = new Date()) {
    const rows = await this.db.select({ userId: memberRoutines.userId }).from(memberRoutines);
    let sent = 0;
    for (const row of rows) {
      try {
        if (await this.deliver(row.userId, now)) sent += 1;
      } catch (error) {
        this.logger.warn(
          `Engagement send failed for ${row.userId}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
    return { checked: rows.length, sent };
  }

  async adminView() {
    const [settings, templates] = await Promise.all([
      this.db.select().from(engagementSettings).where(eq(engagementSettings.id, 'default')).limit(1),
      this.db.select().from(notificationTemplates),
    ]);
    const row = settings[0];
    const merged = mergeTemplates(templates);
    return {
      dailyLimit: row?.dailyLimit ?? DEFAULT_DAILY_LIMIT,
      quietStartMinutes: row?.quietStartMinutes ?? DEFAULT_QUIET_START,
      quietEndMinutes: row?.quietEndMinutes ?? DEFAULT_QUIET_END,
      templates: NOTIFICATION_TYPES.map((type) => merged[type]),
    };
  }

  async updateAdminSettings(patch: Record<string, unknown>) {
    const current = await this.adminView();
    const dailyLimit = assignLimit(patch.dailyLimit, current.dailyLimit);
    const quietStartMinutes = assignMinutes(
      'quietStartMinutes',
      patch.quietStartMinutes,
      current.quietStartMinutes,
    );
    const quietEndMinutes = assignMinutes(
      'quietEndMinutes',
      patch.quietEndMinutes,
      current.quietEndMinutes,
    );
    if (quietStartMinutes == null || quietEndMinutes == null) {
      throw new BadRequestException('Quiet hours need both a start and an end');
    }
    const now = new Date();
    await this.db
      .insert(engagementSettings)
      .values({
        id: 'default',
        dailyLimit,
        quietStartMinutes,
        quietEndMinutes,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: engagementSettings.id,
        set: { dailyLimit, quietStartMinutes, quietEndMinutes, updatedAt: now },
      });
    return this.adminView();
  }

  async updateTemplate(type: string, patch: Record<string, unknown>) {
    if (!isNotificationType(type)) throw new BadRequestException('Unknown notification type');
    const current = mergeTemplates(await this.db.select().from(notificationTemplates))[type];
    const title = assignText('title', patch.title, current.title, 80);
    const body = assignText('body', patch.body, current.body, 180);
    const enabled = assignBool('enabled', patch.enabled, current.enabled);
    const now = new Date();
    await this.db
      .insert(notificationTemplates)
      .values({
        type,
        title,
        body,
        deepLink: current.deepLink,
        enabled,
        priority: current.priority,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: notificationTemplates.type,
        set: { title, body, enabled, updatedAt: now },
      });
    return this.adminView();
  }

  private async deliver(userId: string, now: Date) {
    if (await this.isHyroxMember(userId)) return false;
    const routine = await this.ensureRoutine(userId);
    const decision = await this.decide(userId, routine, now);
    const notice = decision.notification;
    if (notice.result !== 'SEND') return false;
    const alreadySent = await this.sentCount(userId, decision.localDate, notice.type);
    const occurrence = claimOccurrence(notice.type, alreadySent);
    if (occurrence == null) return false;
    const claimed = await this.claim(
      userId,
      notice.type,
      decision.localDate,
      occurrence,
      notice.reason,
    );
    if (!claimed) return false;
    await this.fcm.sendToMember(userId, {
      title: notice.title,
      body: notice.body,
      data: {
        type: `engagement.${notice.type}`,
        route: notice.deepLink,
        noticeTitle: notice.title,
        noticeBody: notice.body,
      },
    });
    return true;
  }

  private async isHyroxMember(userId: string) {
    const rows = await this.db
      .select({
        planId: subscriptions.planId,
        status: subscriptions.status,
        expiresAt: subscriptions.expiresAt,
      })
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .orderBy(desc(subscriptions.updatedAt));
    return rows.some((row) => {
      if (row.planId !== 'hyrox' || row.status !== 'active') return false;
      if (!row.expiresAt) return true;
      return row.expiresAt.getTime() > Date.now();
    });
  }

  private async sentCount(userId: string, localDate: string, type: string) {
    const rows = await this.db
      .select({ id: notificationLogs.id })
      .from(notificationLogs)
      .where(
        and(
          eq(notificationLogs.userId, userId),
          eq(notificationLogs.localDate, localDate),
          eq(notificationLogs.type, type),
          eq(notificationLogs.result, 'SEND'),
        ),
      );
    return rows.length;
  }

  private async claim(
    userId: string,
    type: NotificationType,
    localDate: string,
    occurrence: number,
    reason: string,
  ) {
    const inserted = await this.db
      .insert(notificationLogs)
      .values({
        userId,
        type,
        localDate,
        occurrence,
        result: 'SEND',
        reason,
      })
      .onConflictDoNothing({
        target: [
          notificationLogs.userId,
          notificationLogs.type,
          notificationLogs.localDate,
          notificationLogs.occurrence,
        ],
      })
      .returning({ id: notificationLogs.id });
    return inserted.length > 0;
  }

  private async decide(userId: string, routine: MemberRoutine, now: Date) {
    const parts = zonedParts(now, routine.timezone);
    const date = localDateKey(parts);
    const [settings, sent, day] = await Promise.all([
      this.loadSettings(userId),
      this.loadSent(userId, date, routine.timezone),
      this.loadDay(userId, now, routine.timezone, date),
    ]);
    return evaluate({ now, routine, day, settings, sent });
  }

  private async ensureRoutine(userId: string, timezone?: string): Promise<MemberRoutine> {
    const requested = timezone ? parseTimezone(timezone) : undefined;
    const [row] = await this.db
      .select()
      .from(memberRoutines)
      .where(eq(memberRoutines.userId, userId))
      .limit(1);
    if (!row) {
      const created = blankRoutine(requested ?? 'Asia/Kolkata');
      await this.db.insert(memberRoutines).values({
        userId,
        ...toRoutineRow(created),
        updatedAt: new Date(),
      });
      return created;
    }
    const current = fromRoutineRow(row);
    if (requested && requested !== current.timezone) {
      await this.db
        .update(memberRoutines)
        .set({ timezone: requested, updatedAt: new Date() })
        .where(eq(memberRoutines.userId, userId));
      return { ...current, timezone: requested };
    }
    return current;
  }

  private async readPrefs(userId: string): Promise<CategoryPrefs & { quietStartMinutes: number | null; quietEndMinutes: number | null }> {
    const [row] = await this.db
      .select()
      .from(engagementPreferences)
      .where(eq(engagementPreferences.userId, userId))
      .limit(1);
    if (!row) {
      return {
        workout: true,
        meals: true,
        hydration: true,
        sleep: true,
        motivation: true,
        streak: true,
        quietStartMinutes: null,
        quietEndMinutes: null,
      };
    }
    return {
      workout: row.workout,
      meals: row.meals,
      hydration: row.hydration,
      sleep: row.sleep,
      motivation: row.motivation,
      streak: row.streak,
      quietStartMinutes: row.quietStartMinutes,
      quietEndMinutes: row.quietEndMinutes,
    };
  }

  private async loadSettings(userId: string) {
    const [global, prefs, templates] = await Promise.all([
      this.db.select().from(engagementSettings).where(eq(engagementSettings.id, 'default')).limit(1),
      this.readPrefs(userId),
      this.db.select().from(notificationTemplates),
    ]);
    const settings = global[0];
    const quietStart =
      prefs.quietStartMinutes != null && prefs.quietEndMinutes != null
        ? prefs.quietStartMinutes
        : settings?.quietStartMinutes ?? DEFAULT_QUIET_START;
    const quietEnd =
      prefs.quietStartMinutes != null && prefs.quietEndMinutes != null
        ? prefs.quietEndMinutes
        : settings?.quietEndMinutes ?? DEFAULT_QUIET_END;
    return {
      dailyLimit: settings?.dailyLimit ?? DEFAULT_DAILY_LIMIT,
      quietStartMinutes: quietStart,
      quietEndMinutes: quietEnd,
      prefs,
      templates: mergeTemplates(templates),
    };
  }

  private async loadSent(userId: string, localDate: string, timezone: string): Promise<SentNotice[]> {
    const rows = await this.db
      .select()
      .from(notificationLogs)
      .where(and(eq(notificationLogs.userId, userId), eq(notificationLogs.localDate, localDate)));
    return rows
      .filter((row) => row.result === 'SEND' && isNotificationType(row.type))
      .map((row) => ({
        type: row.type as NotificationType,
        sentAtMinutes: minutesOfDay(zonedParts(row.createdAt, timezone)),
      }));
  }

  private async loadDay(userId: string, now: Date, timezone: string, localDate: string) {
    const [payload, sessions, rewards, skips] = await Promise.all([
      this.workouts.getUserSync(userId),
      this.db
        .select({ checkedInAt: gymSessions.checkedInAt, status: gymSessions.status })
        .from(gymSessions)
        .where(eq(gymSessions.userId, userId))
        .orderBy(desc(gymSessions.checkedInAt))
        .limit(14),
      this.db
        .select({ currentStreak: userRewards.currentStreak })
        .from(userRewards)
        .where(eq(userRewards.userId, userId))
        .limit(1),
      this.db
        .select({ payload: engagementEvents.payload })
        .from(engagementEvents)
        .where(
          and(
            eq(engagementEvents.userId, userId),
            eq(engagementEvents.type, 'MEAL_SKIPPED'),
            eq(engagementEvents.localDate, localDate),
          ),
        ),
    ]);

    const checkedIn = sessions.some((session) => {
      if (session.status === 'open') return true;
      return localDateKey(zonedParts(session.checkedInAt, timezone)) === localDate;
    });
    const recentGymMinutes = sessions.map((session) =>
      minutesOfDay(zonedParts(session.checkedInAt, timezone)),
    );

    return buildDaySnapshot({
      payload,
      localDate,
      weekday: weekdayInZone(now, timezone),
      checkedIn,
      recentGymMinutes,
      streakDays: rewards[0]?.currentStreak ?? 0,
      skippedMeals: skippedMeals(skips.map((row) => row.payload)),
      isLocalDate: (iso) => {
        const parsed = new Date(iso);
        if (Number.isNaN(parsed.getTime())) return false;
        return localDateKey(zonedParts(parsed, timezone)) === localDate;
      },
      minutesOf: (iso) => {
        const parsed = new Date(iso);
        if (Number.isNaN(parsed.getTime())) return null;
        return minutesOfDay(zonedParts(parsed, timezone));
      },
    });
  }
}

function toResponse(
  decision: EngagementDecision,
  routine: MemberRoutine,
  prefs: CategoryPrefs & { quietStartMinutes: number | null; quietEndMinutes: number | null },
) {
  const notification =
    decision.notification.result === 'SEND'
      ? {
          result: 'SEND' as const,
          type: decision.notification.type,
          reason: decision.notification.reason,
          priority: decision.notification.priority,
        }
      : { result: 'SKIP' as const, reason: decision.notification.reason };

  return {
    date: decision.localDate,
    localTime: decision.localTime,
    timezone: decision.timezone,
    experience: decision.experience,
    gym: decision.gym,
    workout: decision.workout,
    meals: decision.meals,
    hydration: decision.hydration,
    actions: decision.actions,
    routine: {
      wakeMinutes: routine.wakeMinutes,
      gymMinutes: routine.gymMinutes,
      breakfastMinutes: routine.breakfastMinutes,
      lunchMinutes: routine.lunchMinutes,
      dinnerMinutes: routine.dinnerMinutes,
      sleepMinutes: routine.sleepMinutes,
    },
    preferences: prefs,
    notification,
  };
}

function blankRoutine(timezone: string): MemberRoutine {
  return {
    timezone,
    wakeMinutes: null,
    gymMinutes: null,
    breakfastMinutes: null,
    lunchMinutes: null,
    dinnerMinutes: null,
    sleepMinutes: null,
  };
}

function fromRoutineRow(row: {
  timezone: string;
  wakeMinutes: number | null;
  gymMinutes: number | null;
  breakfastMinutes: number | null;
  lunchMinutes: number | null;
  dinnerMinutes: number | null;
  sleepMinutes: number | null;
}): MemberRoutine {
  return {
    timezone: row.timezone,
    wakeMinutes: row.wakeMinutes,
    gymMinutes: row.gymMinutes,
    breakfastMinutes: row.breakfastMinutes,
    lunchMinutes: row.lunchMinutes,
    dinnerMinutes: row.dinnerMinutes,
    sleepMinutes: row.sleepMinutes,
  };
}

function toRoutineRow(routine: MemberRoutine) {
  return {
    timezone: routine.timezone,
    wakeMinutes: routine.wakeMinutes,
    gymMinutes: routine.gymMinutes,
    breakfastMinutes: routine.breakfastMinutes,
    lunchMinutes: routine.lunchMinutes,
    dinnerMinutes: routine.dinnerMinutes,
    sleepMinutes: routine.sleepMinutes,
  };
}

function applyRoutinePatch(current: MemberRoutine, patch: RoutinePatch): MemberRoutine {
  return {
    timezone: typeof patch.timezone === 'string' ? parseTimezone(patch.timezone) : current.timezone,
    wakeMinutes: assignMinutes('wakeMinutes', patch.wakeMinutes, current.wakeMinutes),
    gymMinutes: assignMinutes('gymMinutes', patch.gymMinutes, current.gymMinutes),
    breakfastMinutes: assignMinutes('breakfastMinutes', patch.breakfastMinutes, current.breakfastMinutes),
    lunchMinutes: assignMinutes('lunchMinutes', patch.lunchMinutes, current.lunchMinutes),
    dinnerMinutes: assignMinutes('dinnerMinutes', patch.dinnerMinutes, current.dinnerMinutes),
    sleepMinutes: assignMinutes('sleepMinutes', patch.sleepMinutes, current.sleepMinutes),
  };
}

function applyPreferencePatch(
  current: CategoryPrefs & { quietStartMinutes: number | null; quietEndMinutes: number | null },
  patch: PreferencePatch,
) {
  return {
    workout: assignBool('workout', patch.workout, current.workout),
    meals: assignBool('meals', patch.meals, current.meals),
    hydration: assignBool('hydration', patch.hydration, current.hydration),
    sleep: assignBool('sleep', patch.sleep, current.sleep),
    motivation: assignBool('motivation', patch.motivation, current.motivation),
    streak: assignBool('streak', patch.streak, current.streak),
    quietStartMinutes: assignMinutes('quietStartMinutes', patch.quietStartMinutes, current.quietStartMinutes),
    quietEndMinutes: assignMinutes('quietEndMinutes', patch.quietEndMinutes, current.quietEndMinutes),
  };
}

function assignMinutes(field: string, value: unknown, current: number | null): number | null {
  if (value === undefined) return current;
  if (value === null) return null;
  const n = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isInteger(n) || n < 0 || n > 1439) {
    throw new BadRequestException(`${field} must be minutes from midnight, from 0 to 1439`);
  }
  return n;
}

function assignLimit(value: unknown, current: number): number {
  if (value === undefined) return current;
  const n = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isInteger(n) || n < 1 || n > 12) {
    throw new BadRequestException('dailyLimit must be a whole number from 1 to 12');
  }
  return n;
}

function assignText(field: string, value: unknown, current: string, max: number): string {
  if (value === undefined) return current;
  if (typeof value !== 'string') throw new BadRequestException(`${field} must be text`);
  const text = value.trim();
  if (!text || text.length > max) {
    throw new BadRequestException(`${field} must be 1 to ${max} characters`);
  }
  return text;
}

function assignBool(field: string, value: unknown, current: boolean): boolean {
  if (value === undefined) return current;
  if (typeof value !== 'boolean') throw new BadRequestException(`${field} must be true or false`);
  return value;
}

function parseTimezone(value: string): string {
  const timezone = value.trim();
  if (!timezone || timezone.length > 64) throw new BadRequestException('Invalid timezone');
  try {
    zonedParts(new Date(), timezone);
  } catch {
    throw new BadRequestException('Invalid timezone');
  }
  return timezone;
}

function weekdayInZone(now: Date, timezone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(now);
  return WEEKDAYS[name] ?? 1;
}

function mergeTemplates(
  rows: { type: string; title: string; body: string; deepLink: string; enabled: boolean; priority: string }[],
) {
  const templates = { ...DEFAULT_TEMPLATES };
  for (const type of NOTIFICATION_TYPES) {
    const row = rows.find((item) => item.type === type);
    if (!row) continue;
    const priority = isPriority(row.priority) ? row.priority : templates[type].priority;
    templates[type] = {
      type,
      title: row.title,
      body: row.body,
      deepLink: row.deepLink,
      enabled: row.enabled,
      priority,
    };
  }
  return templates;
}

function isPriority(value: string): value is NotificationPriority {
  return value === 'HIGH' || value === 'MEDIUM' || value === 'LOW';
}

function isNotificationType(value: string): value is NotificationType {
  return (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

function skippedMeals(payloads: (string | null)[]): MealSlot[] {
  const slots: MealSlot[] = [];
  for (const raw of payloads) {
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as { meal?: unknown };
      if (parsed.meal === 'breakfast' || parsed.meal === 'lunch' || parsed.meal === 'dinner') {
        slots.push(parsed.meal);
      }
    } catch {
      /* ignore a bad event payload */
    }
  }
  return slots;
}
