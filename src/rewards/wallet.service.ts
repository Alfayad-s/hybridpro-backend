import {
  BadRequestException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DB } from '../db/db.module.js';
import { coinLedger, userRewards } from '../db/schema.js';
import { levelFromXp, levelProgress } from './rewards.constants.js';

type Db = PostgresJsDatabase<typeof import('../db/schema.js')>;

export type UserRewardsDto = {
  id: string;
  userId: string;
  level: number;
  xp: number;
  coins: number;
  currentStreak: number;
  longestStreak: number;
  lastCompletedDate: string | null;
  badges: string[];
  levelProgress: ReturnType<typeof levelProgress>;
  updatedAt: string;
};

function parseBadges(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === 'string')
      : [];
  } catch {
    return [];
  }
}

@Injectable()
export class WalletService {
  constructor(@Inject(DB) private readonly db: Db) {}

  toDto(row: typeof userRewards.$inferSelect): UserRewardsDto {
    return {
      id: row.id,
      userId: row.userId,
      level: row.level,
      xp: row.xp,
      coins: row.coins,
      currentStreak: row.currentStreak,
      longestStreak: row.longestStreak,
      lastCompletedDate: row.lastCompletedDate,
      badges: parseBadges(row.badges),
      levelProgress: levelProgress(row.xp),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async ensure(userId: string): Promise<UserRewardsDto> {
    const [existing] = await this.db
      .select()
      .from(userRewards)
      .where(eq(userRewards.userId, userId))
      .limit(1);
    if (existing) return this.toDto(existing);

    const [inserted] = await this.db
      .insert(userRewards)
      .values({ userId })
      .returning();
    return this.toDto(inserted!);
  }

  async creditCoins(input: {
    userId: string;
    amount: number;
    reason: string;
    refType?: string;
    refId?: string;
  }): Promise<UserRewardsDto> {
    if (input.amount <= 0) {
      throw new BadRequestException('Credit amount must be positive');
    }
    await this.ensure(input.userId);
    const [row] = await this.db
      .select()
      .from(userRewards)
      .where(eq(userRewards.userId, input.userId))
      .limit(1);
    if (!row) throw new BadRequestException('Rewards row missing');

    const nextCoins = row.coins + input.amount;
    const [updated] = await this.db
      .update(userRewards)
      .set({ coins: nextCoins, updatedAt: new Date() })
      .where(eq(userRewards.userId, input.userId))
      .returning();

    await this.db.insert(coinLedger).values({
      userId: input.userId,
      delta: input.amount,
      balanceAfter: nextCoins,
      reason: input.reason,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
    });

    return this.toDto(updated!);
  }

  async debitCoins(input: {
    userId: string;
    amount: number;
    reason: string;
    refType?: string;
    refId?: string;
  }): Promise<UserRewardsDto> {
    if (input.amount <= 0) {
      throw new BadRequestException('Debit amount must be positive');
    }
    await this.ensure(input.userId);
    const [row] = await this.db
      .select()
      .from(userRewards)
      .where(eq(userRewards.userId, input.userId))
      .limit(1);
    if (!row) throw new BadRequestException('Rewards row missing');
    if (row.coins < input.amount) {
      throw new BadRequestException('Insufficient coins');
    }

    const nextCoins = row.coins - input.amount;
    const [updated] = await this.db
      .update(userRewards)
      .set({ coins: nextCoins, updatedAt: new Date() })
      .where(and(eq(userRewards.userId, input.userId), sql`${userRewards.coins} >= ${input.amount}`))
      .returning();

    if (!updated) throw new BadRequestException('Insufficient coins');

    await this.db.insert(coinLedger).values({
      userId: input.userId,
      delta: -input.amount,
      balanceAfter: nextCoins,
      reason: input.reason,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
    });

    return this.toDto(updated);
  }

  async applyChallengeRewards(input: {
    userId: string;
    xpDelta: number;
    coinDelta: number;
    challengeId: string;
    badges: string[];
    currentStreak: number;
    longestStreak: number;
    lastCompletedDate: string | null;
  }): Promise<UserRewardsDto> {
    await this.ensure(input.userId);
    const [row] = await this.db
      .select()
      .from(userRewards)
      .where(eq(userRewards.userId, input.userId))
      .limit(1);
    if (!row) throw new BadRequestException('Rewards row missing');

    const nextXp = row.xp + input.xpDelta;
    const nextCoins = row.coins + input.coinDelta;
    const nextLevel = levelFromXp(nextXp);

    const [updated] = await this.db
      .update(userRewards)
      .set({
        xp: nextXp,
        coins: nextCoins,
        level: nextLevel,
        currentStreak: input.currentStreak,
        longestStreak: input.longestStreak,
        lastCompletedDate: input.lastCompletedDate,
        badges: JSON.stringify(input.badges),
        updatedAt: new Date(),
      })
      .where(eq(userRewards.userId, input.userId))
      .returning();

    if (input.coinDelta !== 0) {
      await this.db.insert(coinLedger).values({
        userId: input.userId,
        delta: input.coinDelta,
        balanceAfter: nextCoins,
        reason: 'challenge_complete',
        refType: 'challenge',
        refId: input.challengeId,
      });
    }

    return this.toDto(updated!);
  }

  async resetStreakIfNeeded(userId: string, today: string): Promise<UserRewardsDto> {
    const rewards = await this.ensure(userId);
    if (!rewards.lastCompletedDate) return rewards;

    const [y, m, d] = today.split('-').map(Number);
    const dt = new Date(y!, m! - 1, d);
    dt.setDate(dt.getDate() - 1);
    const yesterday = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;

    if (
      rewards.lastCompletedDate !== today &&
      rewards.lastCompletedDate !== yesterday &&
      rewards.currentStreak > 0
    ) {
      const [updated] = await this.db
        .update(userRewards)
        .set({ currentStreak: 0, updatedAt: new Date() })
        .where(eq(userRewards.userId, userId))
        .returning();
      return this.toDto(updated!);
    }
    return rewards;
  }

  async listLedger(userId: string, limit = 30) {
    const rows = await this.db
      .select()
      .from(coinLedger)
      .where(eq(coinLedger.userId, userId))
      .orderBy(desc(coinLedger.createdAt))
      .limit(Math.min(100, Math.max(1, limit)));

    return rows.map((r) => ({
      id: r.id,
      delta: r.delta,
      balanceAfter: r.balanceAfter,
      reason: r.reason,
      refType: r.refType,
      refId: r.refId,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
