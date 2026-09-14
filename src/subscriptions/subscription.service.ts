import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, ilike, isNull, or } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DB } from '../db/db.module.js';
import { payments, subscriptions } from '../db/schema.js';
import {
  getPricingPlan,
  isPricingPlanId,
  planRank,
  type PricingPlanId,
} from '../plans.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const ACCESS_DAYS = 30;

type Db = PostgresJsDatabase<typeof import('../db/schema.js')>;
type SubscriptionRecord = typeof subscriptions.$inferSelect;

export type PublicSubscription = {
  id: string;
  userId: string | null;
  email: string;
  mobile: string | null;
  planId: PricingPlanId;
  planName: string;
  status: string;
  startsAt: string | null;
  expiresAt: string | null;
  nextPlanId: string | null;
};

@Injectable()
export class SubscriptionService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private normalizeEmail(email: string) {
    return email.trim().toLowerCase();
  }

  private addDays(from: Date, days: number) {
    return new Date(from.getTime() + days * DAY_MS);
  }

  private toPublic(row: SubscriptionRecord): PublicSubscription | null {
    if (!isPricingPlanId(row.planId)) return null;
    const plan = getPricingPlan(row.planId);
    return {
      id: row.id,
      userId: row.userId,
      email: row.email,
      mobile: row.mobile,
      planId: row.planId,
      planName: plan?.name || row.planId,
      status: row.status,
      startsAt: row.startsAt ? row.startsAt.toISOString() : null,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      nextPlanId: row.nextPlanId,
    };
  }

  private async expireIfNeeded(row: SubscriptionRecord) {
    if (row.status !== 'active' || !row.expiresAt || row.expiresAt.getTime() > Date.now()) {
      return row;
    }

    if (row.nextPlanId && isPricingPlanId(row.nextPlanId)) {
      const startsAt = new Date();
      const [updated] = await this.db
        .update(subscriptions)
        .set({
          planId: row.nextPlanId,
          nextPlanId: null,
          status: 'active',
          startsAt,
          expiresAt: this.addDays(startsAt, ACCESS_DAYS),
        })
        .where(eq(subscriptions.id, row.id))
        .returning();
      return updated ?? { ...row, status: 'expired' as const };
    }

    const [updated] = await this.db
      .update(subscriptions)
      .set({ status: 'expired' })
      .where(eq(subscriptions.id, row.id))
      .returning();
    return updated ?? { ...row, status: 'expired' };
  }

  private async findLatestForIdentity(input: { userId?: string | null; email?: string | null }) {
    const email = input.email ? this.normalizeEmail(input.email) : null;
    const clauses = [
      input.userId ? eq(subscriptions.userId, input.userId) : undefined,
      email ? eq(subscriptions.email, email) : undefined,
    ].filter(Boolean);

    if (clauses.length === 0) return null;

    const [row] = await this.db
      .select()
      .from(subscriptions)
      .where(or(...clauses))
      .orderBy(desc(subscriptions.updatedAt))
      .limit(1);

    return row ?? null;
  }

  async getSubscriptionForIdentity(input: { userId?: string | null; email?: string | null }) {
    const row = await this.findLatestForIdentity(input);
    if (!row) return null;
    return this.toPublic(await this.expireIfNeeded(row));
  }

  async attachSubscriptionToUser(input: { userId: string; email: string }) {
    const email = this.normalizeEmail(input.email);
    await this.db
      .update(subscriptions)
      .set({ userId: input.userId })
      .where(and(eq(subscriptions.email, email), isNull(subscriptions.userId)));
    return this.getSubscriptionForIdentity({ userId: input.userId, email });
  }

  async activateSubscription(input: {
    pineOrderId: string;
    merchantOrderReference: string;
    email: string;
    mobile?: string | null;
    planId: string;
    amountPaise: number;
    userId?: string | null;
  }) {
    if (!isPricingPlanId(input.planId)) throw new Error('Invalid plan');

    const email = this.normalizeEmail(input.email);
    const pineOrderId = input.pineOrderId.trim();
    const merchantOrderReference = input.merchantOrderReference.trim();
    if (!pineOrderId || !merchantOrderReference || !email) {
      throw new Error('Missing payment identity');
    }

    const existingPayment = (
      await this.db.select().from(payments).where(eq(payments.pineOrderId, pineOrderId)).limit(1)
    )[0];

    if (existingPayment) {
      const existingSub = existingPayment.subscriptionId
        ? (
            await this.db
              .select()
              .from(subscriptions)
              .where(eq(subscriptions.id, existingPayment.subscriptionId))
              .limit(1)
          )[0]
        : await this.findLatestForIdentity({ email, userId: input.userId });
      if (existingSub) {
        return {
          alreadyProcessed: true as const,
          subscription: this.toPublic(await this.expireIfNeeded(existingSub)),
        };
      }
    }

    const current = await this.findLatestForIdentity({ email, userId: input.userId });
    const now = new Date();
    const incomingRank = planRank(input.planId);
    const currentRank = current ? planRank(current.planId) : 0;
    const currentActive =
      current?.status === 'active' && current.expiresAt && current.expiresAt.getTime() > now.getTime();

    let startsAt = now;
    let expiresAt = this.addDays(now, ACCESS_DAYS);
    let planId: PricingPlanId = input.planId;
    let nextPlanId: string | null = current?.nextPlanId ?? null;

    if (currentActive && current) {
      if (incomingRank > currentRank) {
        planId = input.planId;
        startsAt = now;
        expiresAt = this.addDays(now, ACCESS_DAYS);
        nextPlanId = null;
      } else if (incomingRank === currentRank) {
        planId = current.planId as PricingPlanId;
        startsAt = current.startsAt ?? now;
        expiresAt = this.addDays(
          current.expiresAt && current.expiresAt > now ? current.expiresAt : now,
          ACCESS_DAYS,
        );
      } else {
        planId = current.planId as PricingPlanId;
        startsAt = current.startsAt ?? now;
        expiresAt = current.expiresAt ?? this.addDays(now, ACCESS_DAYS);
        nextPlanId = input.planId;
      }
    }

    let subscriptionId = current?.id;
    if (current) {
      const [updated] = await this.db
        .update(subscriptions)
        .set({
          userId: input.userId || current.userId,
          email,
          mobile: input.mobile || current.mobile,
          planId,
          nextPlanId,
          status: 'active',
          startsAt,
          expiresAt,
          pineOrderId,
          merchantOrderReference,
        })
        .where(eq(subscriptions.id, current.id))
        .returning();
      subscriptionId = updated?.id ?? current.id;
    } else {
      const [created] = await this.db
        .insert(subscriptions)
        .values({
          userId: input.userId || null,
          email,
          mobile: input.mobile || null,
          planId,
          nextPlanId,
          status: 'active',
          startsAt,
          expiresAt,
          pineOrderId,
          merchantOrderReference,
        })
        .returning();
      subscriptionId = created?.id;
    }

    if (!subscriptionId) throw new Error('Could not save subscription');

    await this.db.insert(payments).values({
      subscriptionId,
      email,
      planId: input.planId,
      amountPaise: input.amountPaise,
      currency: 'INR',
      pineOrderId,
      status: 'paid',
      paidAt: now,
    });

    const [row] = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId))
      .limit(1);
    return { alreadyProcessed: false as const, subscription: row ? this.toPublic(row) : null };
  }

  async listSubscriptions(input?: { q?: string; status?: string; planId?: string }) {
    const filters = [];
    if (input?.status) filters.push(eq(subscriptions.status, input.status));
    if (input?.planId) filters.push(eq(subscriptions.planId, input.planId));
    if (input?.q) {
      const q = `%${input.q.trim().toLowerCase()}%`;
      filters.push(or(ilike(subscriptions.email, q), ilike(subscriptions.mobile, q)));
    }

    const rows = await this.db
      .select()
      .from(subscriptions)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(subscriptions.updatedAt))
      .limit(200);

    const refreshed = await Promise.all(rows.map((row) => this.expireIfNeeded(row)));
    return refreshed.map((row) => this.toPublic(row)).filter(Boolean) as PublicSubscription[];
  }

  async getSubscriptionStats() {
    const rows = await this.db.select().from(subscriptions);
    const now = Date.now();
    let active = 0;
    let expired = 0;
    const byPlan: Record<string, number> = { foundation: 0, performance: 0, elite: 0 };

    for (const row of rows) {
      const isActive = row.status === 'active' && (!row.expiresAt || row.expiresAt.getTime() > now);
      if (isActive) {
        active += 1;
        if (row.planId in byPlan) byPlan[row.planId] += 1;
      } else {
        expired += 1;
      }
    }

    return { total: rows.length, active, expired, byPlan };
  }

  async getClientDetail(id: string) {
    const [row] = await this.db.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1);
    if (!row) return null;
    const current = await this.expireIfNeeded(row);
    const history = await this.db
      .select()
      .from(payments)
      .where(eq(payments.subscriptionId, current.id))
      .orderBy(desc(payments.paidAt));

    return {
      subscription: this.toPublic(current),
      payments: history.map((item) => ({
        id: item.id,
        planId: item.planId,
        amountPaise: item.amountPaise,
        currency: item.currency,
        pineOrderId: item.pineOrderId,
        status: item.status,
        paidAt: item.paidAt.toISOString(),
      })),
    };
  }

  async grantSubscription(input: { email: string; mobile?: string; planId: string; userId?: string }) {
    if (!isPricingPlanId(input.planId)) throw new Error('Invalid plan');
    const plan = getPricingPlan(input.planId)!;
    const stamp = Date.now();
    return this.activateSubscription({
      pineOrderId: `coach-${stamp}-${Math.random().toString(16).slice(2, 10)}`,
      merchantOrderReference: `coach-${input.planId}-${stamp}`,
      email: input.email,
      mobile: input.mobile,
      planId: input.planId,
      amountPaise: plan.amountPaise,
      userId: input.userId,
    });
  }

  async extendSubscription(id: string, days = ACCESS_DAYS) {
    const [row] = await this.db.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1);
    if (!row) throw new Error('Client not found');
    const now = new Date();
    const base = row.expiresAt && row.expiresAt > now ? row.expiresAt : now;
    const [updated] = await this.db
      .update(subscriptions)
      .set({
        status: 'active',
        startsAt: row.startsAt ?? now,
        expiresAt: this.addDays(base, days),
      })
      .where(eq(subscriptions.id, id))
      .returning();
    return updated ? this.toPublic(updated) : null;
  }

  async cancelSubscription(id: string) {
    const [updated] = await this.db
      .update(subscriptions)
      .set({ status: 'cancelled' })
      .where(eq(subscriptions.id, id))
      .returning();
    if (!updated) throw new Error('Client not found');
    return this.toPublic(updated);
  }
}
