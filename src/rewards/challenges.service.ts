import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DB } from '../db/db.module.js';
import {
  challengeHistory,
  dailyChallenges,
  userAppSync,
} from '../db/schema.js';
import {
  generateDailyChallenges,
  generateMonthlyChallenges,
  generateWeeklyChallenges,
} from './challenge-generator.js';
import {
  BADGE_DEFS,
  firstOfMonth,
  formatDateKey,
  mondayOf,
  shiftDate,
  type ChallengePeriod,
  type GeneratedChallenge,
} from './rewards.constants.js';
import { WalletService, type UserRewardsDto } from './wallet.service.js';

type Db = PostgresJsDatabase<typeof import('../db/schema.js')>;

export type ChallengeDto = {
  id: string;
  userId: string;
  date: string;
  period: ChallengePeriod;
  title: string;
  description: string;
  category: string;
  difficulty: string;
  targetValue: number;
  currentValue: number;
  unit: string;
  status: string;
  xpReward: number;
  coinReward: number;
  badgeReward: string | null;
  icon: string | null;
  color: string | null;
  autoComplete: boolean;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CompleteResult = {
  challenge: ChallengeDto;
  rewards: UserRewardsDto;
  leveledUp: boolean;
  allDailyComplete: boolean;
  streakIncreased: boolean;
  newBadges: string[];
};

function num(v: string | number | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

@Injectable()
export class ChallengesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly wallet: WalletService,
  ) {}

  toDto(row: typeof dailyChallenges.$inferSelect): ChallengeDto {
    return {
      id: row.id,
      userId: row.userId,
      date: row.date,
      period: (row.period as ChallengePeriod) || 'daily',
      title: row.title,
      description: row.description,
      category: row.category,
      difficulty: row.difficulty,
      targetValue: num(row.targetValue),
      currentValue: num(row.currentValue),
      unit: row.unit,
      status: row.status,
      xpReward: row.xpReward,
      coinReward: row.coinReward,
      badgeReward: row.badgeReward,
      icon: row.icon,
      color: row.color,
      autoComplete: row.autoComplete,
      completedAt: row.completedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async getChallengesForDate(
    userId: string,
    date: string,
    period: ChallengePeriod = 'daily',
  ): Promise<ChallengeDto[]> {
    const rows = await this.db
      .select()
      .from(dailyChallenges)
      .where(
        and(
          eq(dailyChallenges.userId, userId),
          eq(dailyChallenges.date, date),
          eq(dailyChallenges.period, period),
        ),
      )
      .orderBy(dailyChallenges.createdAt);
    return rows.map((r) => this.toDto(r));
  }

  async insertGenerated(
    userId: string,
    date: string,
    period: ChallengePeriod,
    generated: GeneratedChallenge[],
  ): Promise<ChallengeDto[]> {
    if (!generated.length) return [];
    const rows = await this.db
      .insert(dailyChallenges)
      .values(
        generated.map((g) => ({
          userId,
          date,
          period,
          title: g.title,
          description: g.description,
          category: g.category,
          difficulty: g.difficulty,
          targetValue: String(g.targetValue),
          currentValue: '0',
          unit: g.unit,
          status: 'pending',
          xpReward: g.xpReward ?? 20,
          coinReward: g.coinReward ?? 10,
          badgeReward: g.badgeReward ?? null,
          icon: g.icon ?? null,
          color: g.color ?? null,
          autoComplete: g.autoComplete ?? false,
        })),
      )
      .returning();
    return rows.map((r) => this.toDto(r));
  }

  async expirePendingBefore(userId: string, beforeDate: string) {
    await this.db
      .update(dailyChallenges)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(
        and(
          eq(dailyChallenges.userId, userId),
          eq(dailyChallenges.status, 'pending'),
          eq(dailyChallenges.period, 'daily'),
          lt(dailyChallenges.date, beforeDate),
        ),
      );
  }

  async ensureToday(userId: string, date?: string) {
    const today = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : formatDateKey(new Date());
    const yesterday = shiftDate(today, -1);

    await this.expirePendingBefore(userId, today);
    let rewards = await this.wallet.resetStreakIfNeeded(userId, today);

    let challenges = await this.getChallengesForDate(userId, today, 'daily');
    if (challenges.length === 0) {
      const yesterdayChallenges = await this.getChallengesForDate(
        userId,
        yesterday,
        'daily',
      );
      const skippedYesterday =
        yesterdayChallenges.length > 0 &&
        yesterdayChallenges.every((c) => c.status !== 'completed');

      const syncCtx = await this.readSyncContext(userId, today);
      const generated = generateDailyChallenges({
        todayWorkout: syncCtx.todayWorkout,
        streak: rewards.currentStreak,
        proteinTarget: syncCtx.proteinTarget,
        waterTarget: syncCtx.waterTarget,
        skippedYesterday,
      });
      challenges = await this.insertGenerated(userId, today, 'daily', generated);

      await this.autoCompleteMatching(
        userId,
        today,
        (c) =>
          c.category === 'Habit' &&
          /open|check.?in|app/i.test(`${c.title} ${c.description}`),
      );
      challenges = await this.getChallengesForDate(userId, today, 'daily');
    }

    const weekKey = mondayOf(today);
    let weekly = await this.getChallengesForDate(userId, weekKey, 'weekly');
    if (weekly.length === 0) {
      weekly = await this.insertGenerated(
        userId,
        weekKey,
        'weekly',
        generateWeeklyChallenges(),
      );
    }

    const monthKey = firstOfMonth(today);
    let monthly = await this.getChallengesForDate(userId, monthKey, 'monthly');
    if (monthly.length === 0) {
      monthly = await this.insertGenerated(
        userId,
        monthKey,
        'monthly',
        generateMonthlyChallenges(),
      );
    }

    rewards = await this.wallet.ensure(userId);

    return {
      date: today,
      challenges,
      weekly,
      monthly,
      rewards,
      badges: BADGE_DEFS.map((b) => ({
        ...b,
        earned: rewards.badges.includes(b.id),
      })),
    };
  }

  async complete(
    userId: string,
    challengeId: string,
    currentValue?: number,
  ): Promise<CompleteResult> {
    const [row] = await this.db
      .select()
      .from(dailyChallenges)
      .where(
        and(
          eq(dailyChallenges.id, challengeId),
          eq(dailyChallenges.userId, userId),
        ),
      )
      .limit(1);

    if (!row) throw new NotFoundException('Challenge not found');
    if (row.status === 'completed') {
      throw new BadRequestException('Challenge already completed');
    }
    if (row.status !== 'pending') {
      throw new BadRequestException('Challenge is not pending');
    }

    const target = num(row.targetValue);
    const value = currentValue != null ? currentValue : target;

    const [updated] = await this.db
      .update(dailyChallenges)
      .set({
        status: 'completed',
        currentValue: String(Math.max(value, target)),
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(dailyChallenges.id, challengeId))
      .returning();

    await this.db.insert(challengeHistory).values({
      userId,
      challengeId,
      xpEarned: row.xpReward,
      coinsEarned: row.coinReward,
    });

    const rewards = await this.wallet.ensure(userId);
    const prevLevel = rewards.level;
    const badges = new Set(rewards.badges);
    const newBadges: string[] = [];
    const unlock = (id: string) => {
      if (!badges.has(id)) {
        badges.add(id);
        newBadges.push(id);
      }
    };

    if (row.category === 'Workout') unlock('first_workout');

    const dayChallenges = await this.getChallengesForDate(userId, row.date, 'daily');
    const allDailyComplete =
      row.period === 'daily' &&
      dayChallenges.every((c) => c.id === challengeId || c.status === 'completed');

    let currentStreak = rewards.currentStreak;
    let longestStreak = rewards.longestStreak;
    let lastCompletedDate = rewards.lastCompletedDate;
    let streakIncreased = false;

    if (allDailyComplete) {
      const yesterday = shiftDate(row.date, -1);
      if (rewards.lastCompletedDate === yesterday) {
        currentStreak = rewards.currentStreak + 1;
      } else if (rewards.lastCompletedDate === row.date) {
        currentStreak = rewards.currentStreak;
      } else {
        currentStreak = 1;
      }
      longestStreak = Math.max(longestStreak, currentStreak);
      lastCompletedDate = row.date;
      streakIncreased = currentStreak > rewards.currentStreak;
      if (currentStreak >= 7) unlock('streak_7');
      if (currentStreak >= 30) unlock('streak_30');
    }

    const nextXp = rewards.xp + row.xpReward;
    if (levelFromXpLocal(nextXp) >= 20) unlock('legend');

    await this.unlockMasteryBadges(userId, unlock);

    const nextRewards = await this.wallet.applyChallengeRewards({
      userId,
      xpDelta: row.xpReward,
      coinDelta: row.coinReward,
      challengeId,
      badges: [...badges],
      currentStreak,
      longestStreak,
      lastCompletedDate,
    });

    return {
      challenge: this.toDto(updated!),
      rewards: nextRewards,
      leveledUp: nextRewards.level > prevLevel,
      allDailyComplete,
      streakIncreased,
      newBadges,
    };
  }

  private async unlockMasteryBadges(
    userId: string,
    unlock: (id: string) => void,
  ) {
    const countCat = async (category: string) => {
      const hist = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(challengeHistory)
        .innerJoin(
          dailyChallenges,
          eq(challengeHistory.challengeId, dailyChallenges.id),
        )
        .where(
          and(
            eq(challengeHistory.userId, userId),
            eq(dailyChallenges.category, category),
          ),
        );
      return hist[0]?.count ?? 0;
    };

    if ((await countCat('Hydration')) >= 30) unlock('hydration_master');
    if ((await countCat('Nutrition')) >= 20) unlock('protein_hero');
    if ((await countCat('Workout')) >= 100) unlock('workouts_100');

    const biaHist = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(challengeHistory)
      .innerJoin(
        dailyChallenges,
        eq(challengeHistory.challengeId, dailyChallenges.id),
      )
      .where(
        and(
          eq(challengeHistory.userId, userId),
          sql`lower(${dailyChallenges.title}) like '%bia%'`,
        ),
      );
    if ((biaHist[0]?.count ?? 0) >= 3) unlock('body_transformation');
  }

  async updateProgress(
    userId: string,
    challengeId: string,
    currentValue: number,
  ): Promise<ChallengeDto | null> {
    const [row] = await this.db
      .select()
      .from(dailyChallenges)
      .where(
        and(
          eq(dailyChallenges.id, challengeId),
          eq(dailyChallenges.userId, userId),
        ),
      )
      .limit(1);
    if (!row || row.status !== 'pending') return null;

    const target = num(row.targetValue);
    if (currentValue >= target) {
      const result = await this.complete(userId, challengeId, currentValue);
      return result.challenge;
    }

    const [updated] = await this.db
      .update(dailyChallenges)
      .set({
        currentValue: String(currentValue),
        updatedAt: new Date(),
      })
      .where(eq(dailyChallenges.id, challengeId))
      .returning();
    return updated ? this.toDto(updated) : null;
  }

  async skip(userId: string, challengeId: string): Promise<ChallengeDto> {
    const [updated] = await this.db
      .update(dailyChallenges)
      .set({ status: 'skipped', updatedAt: new Date() })
      .where(
        and(
          eq(dailyChallenges.id, challengeId),
          eq(dailyChallenges.userId, userId),
          eq(dailyChallenges.status, 'pending'),
        ),
      )
      .returning();
    if (!updated) throw new BadRequestException('Unable to skip challenge');
    return this.toDto(updated);
  }

  async refreshDaily(userId: string, date?: string) {
    const today = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : formatDateKey(new Date());
    await this.db
      .delete(dailyChallenges)
      .where(
        and(
          eq(dailyChallenges.userId, userId),
          eq(dailyChallenges.date, today),
          eq(dailyChallenges.period, 'daily'),
          eq(dailyChallenges.status, 'pending'),
        ),
      );
    return this.ensureToday(userId, today);
  }

  async autoCompleteMatching(
    userId: string,
    date: string,
    matcher: (c: ChallengeDto) => boolean,
  ): Promise<CompleteResult[]> {
    const list = await this.getChallengesForDate(userId, date, 'daily');
    const results: CompleteResult[] = [];
    for (const c of list) {
      if (c.status !== 'pending' || !c.autoComplete) continue;
      if (!matcher(c)) continue;
      try {
        results.push(await this.complete(userId, c.id));
      } catch {
        /* already completed / race */
      }
    }
    return results;
  }

  async listHistory(userId: string, limit = 30) {
    const rows = await this.db
      .select({
        id: challengeHistory.id,
        userId: challengeHistory.userId,
        challengeId: challengeHistory.challengeId,
        completedAt: challengeHistory.completedAt,
        xpEarned: challengeHistory.xpEarned,
        coinsEarned: challengeHistory.coinsEarned,
        title: dailyChallenges.title,
        category: dailyChallenges.category,
        difficulty: dailyChallenges.difficulty,
        date: dailyChallenges.date,
        period: dailyChallenges.period,
      })
      .from(challengeHistory)
      .innerJoin(
        dailyChallenges,
        eq(challengeHistory.challengeId, dailyChallenges.id),
      )
      .where(eq(challengeHistory.userId, userId))
      .orderBy(desc(challengeHistory.completedAt))
      .limit(Math.min(100, Math.max(1, limit)));

    return rows.map((r) => ({
      id: r.id,
      challengeId: r.challengeId,
      completedAt: r.completedAt.toISOString(),
      xpEarned: r.xpEarned,
      coinsEarned: r.coinsEarned,
      title: r.title,
      category: r.category,
      difficulty: r.difficulty,
      date: r.date,
      period: r.period,
    }));
  }

  /** Progress challenges from synced workouts / meals / water / weight. */
  async syncProgress(userId: string) {
    const today = formatDateKey(new Date());
    await this.ensureToday(userId, today);
    const ctx = await this.readSyncContext(userId, today);

    const results: CompleteResult[] = [];

    if (ctx.workoutsToday > 0) {
      results.push(
        ...(await this.autoCompleteMatching(userId, today, (c) => {
          const hay = `${c.title} ${c.description} ${c.category}`.toLowerCase();
          return (
            c.category === 'Workout' ||
            c.category === 'Strength' ||
            /workout|train|exercise/i.test(hay)
          );
        })),
      );
    }

    if (ctx.weightLoggedToday) {
      results.push(
        ...(await this.autoCompleteMatching(userId, today, (c) =>
          /weight|measurement/i.test(`${c.title} ${c.description}`),
        )),
      );
    }

    const list = await this.getChallengesForDate(userId, today, 'daily');
    for (const c of list) {
      if (c.status !== 'pending') continue;
      const hay = `${c.title} ${c.description} ${c.category} ${c.unit}`.toLowerCase();
      const isWater =
        c.category === 'Hydration' ||
        c.unit === 'ml' ||
        /water|hydrat|drink/i.test(hay);
      const isProtein =
        (c.unit === 'g' || /protein/i.test(hay)) &&
        (c.category === 'Nutrition' || /protein/i.test(hay));

      if (isWater && ctx.waterMlToday > 0) {
        await this.updateProgress(userId, c.id, ctx.waterMlToday);
      } else if (isProtein && ctx.proteinGToday > 0) {
        await this.updateProgress(userId, c.id, ctx.proteinGToday);
      }
    }

    // Weekly workout count progress
    const weekKey = mondayOf(today);
    const weekly = await this.getChallengesForDate(userId, weekKey, 'weekly');
    for (const c of weekly) {
      if (c.status !== 'pending') continue;
      if (c.unit === 'workouts' || c.category === 'Workout') {
        await this.updateProgress(userId, c.id, ctx.workoutsThisWeek);
      }
      if (c.unit === 'ml' || c.category === 'Hydration') {
        await this.updateProgress(userId, c.id, ctx.waterMlThisWeek);
      }
      if (c.unit === 'g' && /protein/i.test(c.title)) {
        await this.updateProgress(userId, c.id, ctx.proteinGThisWeek);
      }
    }

    const monthKey = firstOfMonth(today);
    const monthly = await this.getChallengesForDate(userId, monthKey, 'monthly');
    for (const c of monthly) {
      if (c.status !== 'pending') continue;
      if (c.unit === 'days' || /train/i.test(c.title)) {
        await this.updateProgress(userId, c.id, ctx.workoutDaysThisMonth);
      }
    }

    return { completed: results.length, date: today };
  }

  private async readSyncContext(userId: string, today: string) {
    const [row] = await this.db
      .select()
      .from(userAppSync)
      .where(eq(userAppSync.userId, userId))
      .limit(1);

    let todayWorkout: string | null = null;
    let waterTarget = 3000;
    let proteinTarget = 150;
    let waterMlToday = 0;
    let proteinGToday = 0;
    let workoutsToday = 0;
    let workoutsThisWeek = 0;
    let waterMlThisWeek = 0;
    let proteinGThisWeek = 0;
    let workoutDaysThisMonth = 0;
    let weightLoggedToday = false;

    if (!row?.payload) {
      return {
        todayWorkout,
        waterTarget,
        proteinTarget,
        waterMlToday,
        proteinGToday,
        workoutsToday,
        workoutsThisWeek,
        waterMlThisWeek,
        proteinGThisWeek,
        workoutDaysThisMonth,
        weightLoggedToday,
      };
    }

    try {
      const payload = JSON.parse(row.payload) as {
        stores?: Record<string, { data?: unknown }>;
      };
      const stores = payload.stores ?? {};

      const historyRaw = stores.history?.data;
      const history = Array.isArray(historyRaw) ? historyRaw : [];
      const weekKey = mondayOf(today);
      const monthKey = firstOfMonth(today);
      const trainedDays = new Set<string>();

      for (const h of history) {
        if (!h || typeof h !== 'object') continue;
        const item = h as { completedAt?: string; name?: string; title?: string };
        const completedAt = item.completedAt;
        if (!completedAt) continue;
        const day = completedAt.slice(0, 10);
        if (day === today) {
          workoutsToday += 1;
          todayWorkout = todayWorkout ?? item.name ?? item.title ?? 'Workout';
        }
        if (day >= weekKey && day <= today) workoutsThisWeek += 1;
        if (day >= monthKey && day <= today) trainedDays.add(day);
      }
      workoutDaysThisMonth = trainedDays.size;

      const mealsData = stores.meals?.data;
      const mealsObj =
        mealsData && typeof mealsData === 'object'
          ? (mealsData as {
              entries?: Array<{ date?: string; proteinG?: number; protein?: number }>;
              waterLogs?: Array<{ date?: string; amountMl?: number }>;
            })
          : { entries: [], waterLogs: [] };

      for (const w of mealsObj.waterLogs ?? []) {
        if (w.date === today) waterMlToday += Number(w.amountMl) || 0;
        if (w.date && w.date >= weekKey && w.date <= today) {
          waterMlThisWeek += Number(w.amountMl) || 0;
        }
      }
      for (const e of mealsObj.entries ?? []) {
        const p = Number(e.proteinG ?? e.protein) || 0;
        if (e.date === today) proteinGToday += p;
        if (e.date && e.date >= weekKey && e.date <= today) proteinGThisWeek += p;
      }

      const profile = stores.profile?.data;
      if (profile && typeof profile === 'object') {
        const p = profile as {
          waterTargetMl?: number;
          proteinTargetG?: number;
          bodyWeightLogs?: Array<{ date?: string }>;
        };
        if (typeof p.waterTargetMl === 'number' && p.waterTargetMl > 0) {
          waterTarget = p.waterTargetMl;
        }
        if (typeof p.proteinTargetG === 'number' && p.proteinTargetG > 0) {
          proteinTarget = p.proteinTargetG;
        }
        const logs = Array.isArray(p.bodyWeightLogs) ? p.bodyWeightLogs : [];
        weightLoggedToday = logs.some((l) => l.date?.slice(0, 10) === today);
      }
    } catch {
      /* ignore bad payload */
    }

    return {
      todayWorkout,
      waterTarget,
      proteinTarget,
      waterMlToday,
      proteinGToday,
      workoutsToday,
      workoutsThisWeek,
      waterMlThisWeek,
      proteinGThisWeek,
      workoutDaysThisMonth,
      weightLoggedToday,
    };
  }
}

function levelFromXpLocal(xp: number): number {
  let level = 1;
  const xpFor = (l: number) => {
    if (l <= 1) return 0;
    if (l === 2) return 100;
    if (l === 3) return 250;
    if (l === 4) return 500;
    return 500 + (l - 4) * 250;
  };
  while (xpFor(level + 1) <= xp) {
    level += 1;
    if (level > 500) break;
  }
  return level;
}
