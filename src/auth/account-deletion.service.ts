import { Inject, Injectable } from '@nestjs/common';
import { eq, inArray, or } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DB } from '../db/db.module.js';
import {
  challengeHistory,
  coachConversations,
  coinLedger,
  coinRedemptions,
  contactSubmissions,
  dailyChallenges,
  deviceTokens,
  emailOtps,
  engagementEvents,
  engagementPreferences,
  exercises,
  gymSessions,
  memberAccounts,
  memberRoutines,
  notificationLogs,
  payments,
  profiles,
  subscriptionEvents,
  subscriptions,
  userAppSync,
  userRewards,
} from '../db/schema.js';

type Db = PostgresJsDatabase<typeof import('../db/schema.js')>;

@Injectable()
export class AccountDeletionService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async deleteMember(input: { userId: string; email: string }) {
    const userId = input.userId.trim();
    const email = input.email.trim().toLowerCase();
    if (!userId || !email.includes('@')) {
      throw new Error('Account identity is missing');
    }

    await this.db.transaction(async (tx) => {
      const subs = await tx
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(or(eq(subscriptions.userId, userId), eq(subscriptions.email, email)));
      const subIds = subs.map((row) => row.id);

      await tx.delete(challengeHistory).where(eq(challengeHistory.userId, userId));
      await tx.delete(dailyChallenges).where(eq(dailyChallenges.userId, userId));
      await tx.delete(coinLedger).where(eq(coinLedger.userId, userId));
      await tx.delete(coinRedemptions).where(eq(coinRedemptions.userId, userId));
      await tx.delete(userRewards).where(eq(userRewards.userId, userId));
      await tx.delete(notificationLogs).where(eq(notificationLogs.userId, userId));
      await tx.delete(engagementEvents).where(eq(engagementEvents.userId, userId));
      await tx.delete(engagementPreferences).where(eq(engagementPreferences.userId, userId));
      await tx.delete(memberRoutines).where(eq(memberRoutines.userId, userId));
      await tx.delete(deviceTokens).where(eq(deviceTokens.userId, userId));
      await tx.delete(gymSessions).where(eq(gymSessions.userId, userId));
      await tx.delete(userAppSync).where(eq(userAppSync.userId, userId));
      await tx.delete(exercises).where(eq(exercises.userId, userId));
      await tx.delete(coachConversations).where(eq(coachConversations.memberUserId, userId));

      await tx.delete(payments).where(eq(payments.email, email));
      await tx.delete(subscriptionEvents).where(eq(subscriptionEvents.email, email));
      if (subIds.length > 0) {
        await tx.delete(subscriptions).where(inArray(subscriptions.id, subIds));
      }
      await tx.delete(contactSubmissions).where(eq(contactSubmissions.email, email));
      await tx.delete(profiles).where(eq(profiles.id, userId));
      await tx.delete(emailOtps).where(eq(emailOtps.email, email));
      await tx.delete(memberAccounts).where(eq(memberAccounts.id, userId));
    });

    return { ok: true as const };
  }
}
