import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DB } from '../db/db.module.js';
import { payments, profiles, subscriptionEvents, subscriptions } from '../db/schema.js';
import {
  getPricingPlan,
  isPricingPlanId,
  planRank,
  type PricingPlanId,
} from '../plans.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const ACCESS_DAYS = 30;
const EXPIRING_SOON_DAYS = 7;

type Db = PostgresJsDatabase<typeof import('../db/schema.js')>;
type SubscriptionRecord = typeof subscriptions.$inferSelect;

export type SubscriptionEventAction =
  | 'activated'
  | 'renewed'
  | 'upgraded'
  | 'granted'
  | 'extended'
  | 'cancelled'
  | 'changed';

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
  daysRemaining: number | null;
  nextPlanId: string | null;
  fullName: string | null;
  avatarUrl: string | null;
  appLinked: boolean;
};

export type AdminClientRow = PublicSubscription & {
  paymentCount: number;
  totalPaidPaise: number;
  grantCount: number;
  totalGrantedPaise: number;
  lastAmountPaise: number;
  lastPaidAt: string | null;
  expiringSoon: boolean;
};

export type AdminPaymentRow = {
  id: string;
  subscriptionId: string | null;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  planId: string;
  planName: string;
  amountPaise: number;
  currency: string;
  pineOrderId: string | null;
  status: 'paid' | 'granted';
  paidAt: string;
};

export type AdminSubscriptionEvent = {
  id: string;
  action: string;
  planId: string;
  planName: string;
  startsAt: string | null;
  expiresAt: string | null;
  amountPaise: number | null;
  createdAt: string;
};

function isGrantedPayment(item: { status: string; pineOrderId?: string | null }) {
  if (item.status === 'granted') return true;
  return Boolean(item.pineOrderId?.startsWith('coach-'));
}

function paymentKind(item: { status: string; pineOrderId?: string | null }): 'paid' | 'granted' {
  return isGrantedPayment(item) ? 'granted' : 'paid';
}

function parseDayStart(value?: string) {
  const raw = value?.trim();
  if (!raw) return null;
  const [year, month, day] = raw.split('-').map(Number);
  if (!year || !month || !day) return null;
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
}

function parseDayEnd(value?: string) {
  const raw = value?.trim();
  if (!raw) return null;
  const [year, month, day] = raw.split('-').map(Number);
  if (!year || !month || !day) return null;
  return new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
}

@Injectable()
export class SubscriptionService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private normalizeEmail(email: string) {
    return email.trim().toLowerCase();
  }

  private addDays(from: Date, days: number) {
    return new Date(from.getTime() + days * DAY_MS);
  }

  private asDate(value: Date | string | null | undefined) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private isLive(row: SubscriptionRecord) {
    if (row.status !== 'active' && row.status !== 'expired') return false;
    const expiresAt = this.asDate(row.expiresAt);
    if (expiresAt && expiresAt.getTime() <= Date.now()) return false;
    return row.status === 'active' || Boolean(expiresAt);
  }

  private daysRemainingFor(row: SubscriptionRecord, live = this.isLive(row)) {
    const expiresAt = this.asDate(row.expiresAt);
    if (!live || !expiresAt) return null;
    return Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / DAY_MS));
  }

  private toPublic(
    row: SubscriptionRecord,
    profile?: { fullName: string | null; avatarUrl: string | null } | null,
  ): PublicSubscription | null {
    if (!isPricingPlanId(row.planId)) return null;
    const plan = getPricingPlan(row.planId);
    const startsAt = this.asDate(row.startsAt);
    const expiresAt = this.asDate(row.expiresAt);
    const live = this.isLive(row);
    const daysRemaining = this.daysRemainingFor(row, live);
    return {
      id: row.id,
      userId: row.userId,
      email: row.email,
      mobile: row.mobile,
      planId: row.planId,
      planName: plan?.name || row.planId,
      status: live ? 'active' : row.status,
      startsAt: startsAt ? startsAt.toISOString() : null,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      daysRemaining,
      nextPlanId: row.nextPlanId,
      fullName: profile?.fullName ?? null,
      avatarUrl: profile?.avatarUrl ?? null,
      appLinked: Boolean(row.userId),
    };
  }

  private async recordEvent(input: {
    subscriptionId: string;
    email: string;
    planId: string;
    action: SubscriptionEventAction;
    startsAt?: Date | string | null;
    expiresAt?: Date | string | null;
    amountPaise?: number | null;
  }) {
    const startsAt = this.asDate(input.startsAt ?? null);
    const expiresAt = this.asDate(input.expiresAt ?? null);
    try {
      await this.db.insert(subscriptionEvents).values({
        subscriptionId: input.subscriptionId,
        email: this.normalizeEmail(input.email),
        planId: input.planId,
        action: input.action,
        startsAt,
        expiresAt,
        amountPaise: input.amountPaise ?? null,
      });
    } catch (error) {
      console.error('[subscription_events]', error);
    }
  }

  private toEventRow(row: typeof subscriptionEvents.$inferSelect): AdminSubscriptionEvent {
    const plan = getPricingPlan(row.planId);
    const startsAt = this.asDate(row.startsAt);
    const expiresAt = this.asDate(row.expiresAt);
    return {
      id: row.id,
      action: row.action,
      planId: row.planId,
      planName: plan?.name || row.planId,
      startsAt: startsAt ? startsAt.toISOString() : null,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      amountPaise: row.amountPaise,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async expireIfNeeded(row: SubscriptionRecord) {
    const expiresAt = this.asDate(row.expiresAt);
    if (row.status === 'expired' && expiresAt && expiresAt.getTime() > Date.now()) {
      const [restored] = await this.db
        .update(subscriptions)
        .set({ status: 'active' })
        .where(eq(subscriptions.id, row.id))
        .returning();
      return restored ?? { ...row, status: 'active' as const };
    }

    if (row.status !== 'active' || !expiresAt || expiresAt.getTime() > Date.now()) {
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

    const rows = await this.db
      .select()
      .from(subscriptions)
      .where(or(...clauses))
      .orderBy(desc(subscriptions.updatedAt))
      .limit(10);

    const now = Date.now();
    return (
      rows.find((row) => {
        if (row.status !== 'active' && row.status !== 'expired') return false;
        const expiresAt = this.asDate(row.expiresAt);
        if (expiresAt && expiresAt.getTime() <= now) return false;
        return row.status === 'active' || Boolean(expiresAt);
      }) ??
      rows[0] ??
      null
    );
  }

  async getSubscriptionForIdentity(input: { userId?: string | null; email?: string | null }) {
    const row = await this.findLatestForIdentity(input);
    if (!row) return null;
    return this.toPublic(await this.expireIfNeeded(row));
  }

  async getPlanForIdentity(input: { userId?: string | null; email?: string | null }) {
    const subscription = await this.getSubscriptionForIdentity(input);
    const active = Boolean(
      subscription &&
        subscription.status === 'active' &&
        (!subscription.expiresAt || new Date(subscription.expiresAt).getTime() > Date.now()),
    );
    const daysRemaining =
      active && subscription?.expiresAt
        ? Math.max(0, Math.ceil((new Date(subscription.expiresAt).getTime() - Date.now()) / DAY_MS))
        : null;

    return {
      active,
      planId: active ? subscription?.planId ?? null : null,
      planName: active ? subscription?.planName ?? null : null,
      expiresAt: subscription?.expiresAt ?? null,
      daysRemaining,
      subscription,
    };
  }

  private missingRelation(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return /relation .* does not exist/i.test(message);
  }

  private asRows<T>(result: unknown): T[] {
    if (Array.isArray(result)) return result as T[];
    if (
      result &&
      typeof result === 'object' &&
      'rows' in result &&
      Array.isArray((result as { rows: unknown }).rows)
    ) {
      return (result as { rows: T[] }).rows;
    }
    return [];
  }

  private async profilesByUserIds(userIds: Array<string | null | undefined>) {
    const empty = new Map<string, { fullName: string | null; avatarUrl: string | null }>();
    const ids = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
    if (ids.length === 0) return empty;

    try {
      const rows = await this.db.select().from(profiles).where(inArray(profiles.id, ids));
      if (rows.length > 0) {
        return new Map(
          rows.map((row) => [row.id, { fullName: row.fullName, avatarUrl: row.avatarUrl }]),
        );
      }
    } catch (error) {
      if (!this.missingRelation(error)) console.error('[profiles]', error);
    }

    try {
      const result = await this.db.execute(sql`
        select
          id::text as id,
          coalesce(
            raw_user_meta_data->>'full_name',
            raw_user_meta_data->>'name',
            split_part(email, '@', 1)
          ) as "fullName",
          coalesce(
            raw_user_meta_data->>'avatar_url',
            raw_user_meta_data->>'picture'
          ) as "avatarUrl"
        from auth.users
        where id::text in (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})
      `);
      const rows = this.asRows<{
        id: string;
        fullName: string | null;
        avatarUrl: string | null;
      }>(result);
      return new Map(
        rows.map((row) => [row.id, { fullName: row.fullName ?? null, avatarUrl: row.avatarUrl ?? null }]),
      );
    } catch (error) {
      if (!this.missingRelation(error)) console.error('[auth.users]', error);
      return empty;
    }
  }

  private async profileIdsMatchingName(q: string) {
    try {
      const nameMatches = await this.db
        .select({ id: profiles.id })
        .from(profiles)
        .where(ilike(profiles.fullName, q));
      if (nameMatches.length > 0) return nameMatches.map((row) => row.id);
    } catch (error) {
      if (!this.missingRelation(error)) console.error('[profiles]', error);
    }

    try {
      const result = await this.db.execute(sql`
        select id::text as id
        from auth.users
        where coalesce(
          raw_user_meta_data->>'full_name',
          raw_user_meta_data->>'name',
          email
        ) ilike ${q}
      `);
      return this.asRows<{ id: string }>(result).map((row) => row.id);
    } catch (error) {
      if (!this.missingRelation(error)) console.error('[auth.users]', error);
      return [];
    }
  }

  async attachSubscriptionToUser(input: { userId: string; email: string }) {
    const email = this.normalizeEmail(input.email);
    await this.db
      .update(subscriptions)
      .set({ userId: input.userId })
      .where(eq(subscriptions.email, email));
    return this.getSubscriptionForIdentity({ userId: input.userId, email });
  }

  async saveCheckoutIntent(input: {
    pineOrderId?: string | null;
    merchantOrderReference: string;
    email: string;
    mobile?: string | null;
    planId: string;
    userId?: string | null;
  }) {
    if (!isPricingPlanId(input.planId)) throw new Error('Invalid plan');
    const email = this.normalizeEmail(input.email);
    const pineOrderId = input.pineOrderId?.trim() || null;
    const merchantOrderReference = input.merchantOrderReference.trim();
    if (!email || !merchantOrderReference) throw new Error('Missing checkout identity');

    const existing =
      (pineOrderId
        ? (
            await this.db
              .select()
              .from(subscriptions)
              .where(eq(subscriptions.pineOrderId, pineOrderId))
              .limit(1)
          )[0]
        : null) ||
      (
        await this.db
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.merchantOrderReference, merchantOrderReference))
          .limit(1)
      )[0] ||
      (await this.findLatestForIdentity({ email, userId: input.userId }));

    if (existing?.status === 'active') {
      return this.toPublic(existing);
    }

    const payload = {
      userId: input.userId || existing?.userId || null,
      email,
      mobile: input.mobile || existing?.mobile || null,
      planId: input.planId,
      pineOrderId: pineOrderId || existing?.pineOrderId || null,
      merchantOrderReference,
      status: 'pending' as const,
    };

    if (existing) {
      const [updated] = await this.db
        .update(subscriptions)
        .set(payload)
        .where(eq(subscriptions.id, existing.id))
        .returning();
      return this.toPublic(updated ?? existing);
    }

    const [created] = await this.db.insert(subscriptions).values(payload).returning();
    return created ? this.toPublic(created) : null;
  }

  async getCheckoutIntent(input: { pineOrderId?: string | null; merchantOrderReference?: string | null }) {
    const row = await this.findCheckoutRow(input);
    return row ? this.toPublic(row) : null;
  }

  private async findCheckoutRow(input: {
    pineOrderId?: string | null;
    merchantOrderReference?: string | null;
  }) {
    const pineOrderId = input.pineOrderId?.trim();
    const merchantOrderReference = input.merchantOrderReference?.trim();
    const clauses = [
      pineOrderId ? eq(subscriptions.pineOrderId, pineOrderId) : undefined,
      merchantOrderReference
        ? eq(subscriptions.merchantOrderReference, merchantOrderReference)
        : undefined,
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

  async confirmPaymentReturn(input: {
    pineOrderId?: string | null;
    merchantOrderReference?: string | null;
    email?: string | null;
    mobile?: string | null;
    planId?: string | null;
    userId?: string | null;
    status?: string | null;
  }) {
    const status = (input.status || '').trim().toLowerCase();
    if (['failed', 'failure', 'cancelled', 'canceled'].includes(status)) {
      return { ok: false as const, reason: 'failed' as const, email: null, subscription: null };
    }

    const row = await this.findCheckoutRow({
      pineOrderId: input.pineOrderId,
      merchantOrderReference: input.merchantOrderReference,
    });

    const pineOrderId = (input.pineOrderId || row?.pineOrderId || '').trim();
    const merchantOrderReference =
      (input.merchantOrderReference || row?.merchantOrderReference || '').trim() ||
      (pineOrderId ? `hp-${pineOrderId}` : '');
    const email = this.normalizeEmail(input.email || row?.email || '');
    const planId = (input.planId || row?.planId || '').trim();
    const userId = (input.userId || row?.userId || '').trim();
    const mobile = input.mobile || row?.mobile || null;
    const plan = getPricingPlan(planId);

    if (!pineOrderId || !merchantOrderReference || !email.includes('@') || !plan) {
      throw new Error('Could not confirm this payment');
    }

    const result = await this.activateSubscription({
      pineOrderId,
      merchantOrderReference,
      email,
      mobile,
      planId: plan.id,
      amountPaise: plan.amountPaise,
      userId: userId || null,
    });

    return {
      ok: true as const,
      reason: 'activated' as const,
      email,
      planId: plan.id,
      planName: plan.name,
      alreadyProcessed: result.alreadyProcessed,
      subscription: result.subscription,
    };
  }

  async activateSubscription(input: {
    pineOrderId: string;
    merchantOrderReference: string;
    email: string;
    mobile?: string | null;
    planId: string;
    amountPaise: number;
    userId?: string | null;
    paymentStatus?: 'paid' | 'granted';
    eventAction?: SubscriptionEventAction;
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

    const paymentStatus = input.paymentStatus || 'paid';
    await this.db.insert(payments).values({
      subscriptionId,
      email,
      planId: input.planId,
      amountPaise: input.amountPaise,
      currency: 'INR',
      pineOrderId,
      status: paymentStatus,
      paidAt: now,
    });

    const [row] = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId))
      .limit(1);

    const eventAction =
      input.eventAction ||
      (!current
        ? 'activated'
        : currentActive && incomingRank > currentRank
          ? 'upgraded'
          : currentActive && incomingRank === currentRank
            ? 'renewed'
            : 'activated');

    if (row) {
      await this.recordEvent({
        subscriptionId: row.id,
        email,
        planId: input.planId,
        action: eventAction,
        startsAt: row.startsAt,
        expiresAt: row.expiresAt,
        amountPaise: input.amountPaise,
      });
    }

    return { alreadyProcessed: false as const, subscription: row ? this.toPublic(row) : null };
  }

  async listSubscriptions(input?: {
    q?: string;
    status?: string;
    planId?: string;
    expiringSoon?: boolean;
  }) {
    const filters = [];
    if (input?.status) filters.push(eq(subscriptions.status, input.status));
    if (input?.planId) filters.push(eq(subscriptions.planId, input.planId));
    if (input?.q) {
      const q = `%${input.q.trim().toLowerCase()}%`;
      const nameIds = await this.profileIdsMatchingName(q);
      const identityClauses = [
        ilike(subscriptions.email, q),
        ilike(subscriptions.mobile, q),
        ...(nameIds.length ? [inArray(subscriptions.userId, nameIds)] : []),
      ];
      filters.push(or(...identityClauses));
    }

    const rows = await this.db
      .select()
      .from(subscriptions)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(subscriptions.updatedAt))
      .limit(200);

    const refreshed = await Promise.all(rows.map((row) => this.expireIfNeeded(row)));
    const ids = refreshed.map((row) => row.id);
    const profileByUserId = await this.profilesByUserIds(refreshed.map((row) => row.userId));
    const payRows = ids.length
      ? await this.db.select().from(payments).where(inArray(payments.subscriptionId, ids))
      : [];

    const payBySub = new Map<
      string,
      {
        totalPaidPaise: number;
        totalGrantedPaise: number;
        lastPaidAt: Date;
        lastAmountPaise: number;
        paymentCount: number;
        grantCount: number;
      }
    >();
    for (const item of payRows) {
      if (!item.subscriptionId) continue;
      if (item.status !== 'paid' && item.status !== 'granted') continue;
      const granted = isGrantedPayment(item);
      const current = payBySub.get(item.subscriptionId);
      if (!current) {
        payBySub.set(item.subscriptionId, {
          totalPaidPaise: granted ? 0 : item.amountPaise,
          totalGrantedPaise: granted ? item.amountPaise : 0,
          lastPaidAt: item.paidAt,
          lastAmountPaise: item.amountPaise,
          paymentCount: granted ? 0 : 1,
          grantCount: granted ? 1 : 0,
        });
        continue;
      }
      if (granted) {
        current.totalGrantedPaise += item.amountPaise;
        current.grantCount += 1;
      } else {
        current.totalPaidPaise += item.amountPaise;
        current.paymentCount += 1;
      }
      if (item.paidAt > current.lastPaidAt) {
        current.lastPaidAt = item.paidAt;
        current.lastAmountPaise = item.amountPaise;
      }
    }

    const clients: AdminClientRow[] = [];
    for (const row of refreshed) {
      const pub = this.toPublic(
        row,
        row.userId ? profileByUserId.get(row.userId) ?? null : null,
      );
      if (!pub) continue;
      if (input?.status && pub.status !== input.status) continue;
      const pay = payBySub.get(row.id);
      const expiringSoon =
        pub.status === 'active' &&
        pub.daysRemaining != null &&
        pub.daysRemaining <= EXPIRING_SOON_DAYS;
      if (input?.expiringSoon && !expiringSoon) continue;
      clients.push({
        ...pub,
        paymentCount: pay?.paymentCount ?? 0,
        totalPaidPaise: pay?.totalPaidPaise ?? 0,
        grantCount: pay?.grantCount ?? 0,
        totalGrantedPaise: pay?.totalGrantedPaise ?? 0,
        lastAmountPaise: pay?.lastAmountPaise ?? 0,
        lastPaidAt: pay?.lastPaidAt ? pay.lastPaidAt.toISOString() : null,
        expiringSoon,
      });
    }

    clients.sort((a, b) => {
      if (input?.expiringSoon) {
        return (a.daysRemaining ?? 999) - (b.daysRemaining ?? 999);
      }
      const aActive = a.status === 'active' ? 0 : 1;
      const bActive = b.status === 'active' ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      const aPaid = a.lastPaidAt ? new Date(a.lastPaidAt).getTime() : 0;
      const bPaid = b.lastPaidAt ? new Date(b.lastPaidAt).getTime() : 0;
      return bPaid - aPaid;
    });

    return clients;
  }

  async getSubscriptionStats() {
    const rows = await this.db.select().from(subscriptions);
    const now = Date.now();
    let active = 0;
    let expired = 0;
    let expiringSoon = 0;
    const byPlan: Record<string, number> = { foundation: 0, performance: 0, elite: 0 };

    for (const row of rows) {
      const isActive = row.status === 'active' && (!row.expiresAt || row.expiresAt.getTime() > now);
      if (isActive) {
        active += 1;
        if (row.planId in byPlan) byPlan[row.planId] += 1;
        const days = this.daysRemainingFor(row, true);
        if (days != null && days <= EXPIRING_SOON_DAYS) expiringSoon += 1;
      } else {
        expired += 1;
      }
    }

    const payRows = await this.db.select().from(payments);
    let paidOrders = 0;
    let revenuePaise = 0;
    let grantedOrders = 0;
    let grantedPaise = 0;
    const paidClientIds = new Set<string>();
    for (const item of payRows) {
      if (item.status !== 'paid' && item.status !== 'granted') continue;
      if (isGrantedPayment(item)) {
        grantedOrders += 1;
        grantedPaise += item.amountPaise;
        continue;
      }
      paidOrders += 1;
      revenuePaise += item.amountPaise;
      if (item.subscriptionId) paidClientIds.add(item.subscriptionId);
    }

    return {
      total: rows.length,
      active,
      expired,
      expiringSoon,
      byPlan,
      paidOrders,
      paidClients: paidClientIds.size,
      revenuePaise,
      grantedOrders,
      grantedPaise,
    };
  }

  async getClientDetail(id: string) {
    const [row] = await this.db.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1);
    if (!row) return null;
    const current = await this.expireIfNeeded(row);
    const profileByUserId = await this.profilesByUserIds([current.userId]);
    const history = await this.db
      .select()
      .from(payments)
      .where(eq(payments.subscriptionId, current.id))
      .orderBy(desc(payments.paidAt));

    let eventRows: (typeof subscriptionEvents.$inferSelect)[] = [];
    try {
      eventRows = await this.db
        .select()
        .from(subscriptionEvents)
        .where(eq(subscriptionEvents.subscriptionId, current.id))
        .orderBy(desc(subscriptionEvents.createdAt));
    } catch (error) {
      console.error('[subscription_events]', error);
    }

    const events =
      eventRows.length > 0
        ? eventRows.map((item) => this.toEventRow(item))
        : history.map((item) => {
            const plan = getPricingPlan(item.planId);
            return {
              id: item.id,
              action: isGrantedPayment(item) ? 'granted' : 'activated',
              planId: item.planId,
              planName: plan?.name || item.planId,
              startsAt: null,
              expiresAt: null,
              amountPaise: item.amountPaise,
              createdAt: item.paidAt.toISOString(),
            } satisfies AdminSubscriptionEvent;
          });

    const subscription = this.toPublic(
      current,
      current.userId ? profileByUserId.get(current.userId) ?? null : null,
    );

    return {
      subscription,
      events,
      payments: history.map((item) => ({
        id: item.id,
        planId: item.planId,
        amountPaise: item.amountPaise,
        currency: item.currency,
        pineOrderId: item.pineOrderId,
        status: paymentKind(item),
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
      paymentStatus: 'granted',
      eventAction: 'granted',
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
    if (updated) {
      await this.recordEvent({
        subscriptionId: updated.id,
        email: updated.email,
        planId: updated.planId,
        action: 'extended',
        startsAt: updated.startsAt,
        expiresAt: updated.expiresAt,
        amountPaise: 0,
      });
    }
    return updated ? this.toPublic(updated) : null;
  }

  async cancelSubscription(id: string) {
    const [updated] = await this.db
      .update(subscriptions)
      .set({ status: 'cancelled' })
      .where(eq(subscriptions.id, id))
      .returning();
    if (!updated) throw new Error('Client not found');
    await this.recordEvent({
      subscriptionId: updated.id,
      email: updated.email,
      planId: updated.planId,
      action: 'cancelled',
      startsAt: updated.startsAt,
      expiresAt: updated.expiresAt,
      amountPaise: 0,
    });
    return this.toPublic(updated);
  }

  async changePlan(id: string, planId: string) {
    if (!isPricingPlanId(planId)) throw new Error('Invalid plan');
    const [row] = await this.db.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1);
    if (!row) throw new Error('Client not found');
    const current = await this.expireIfNeeded(row);
    if (current.planId === planId) throw new Error('Client is already on this plan');
    const live = this.isLive(current);
    if (!live) throw new Error('Extend or grant access before changing plan');

    const incomingRank = planRank(planId);
    const currentRank = planRank(current.planId);
    const action: SubscriptionEventAction = incomingRank > currentRank ? 'upgraded' : 'changed';
    const [updated] = await this.db
      .update(subscriptions)
      .set({
        planId,
        nextPlanId: null,
        status: 'active',
      })
      .where(eq(subscriptions.id, current.id))
      .returning();
    if (!updated) throw new Error('Could not change plan');
    await this.recordEvent({
      subscriptionId: updated.id,
      email: updated.email,
      planId,
      action,
      startsAt: updated.startsAt,
      expiresAt: updated.expiresAt,
      amountPaise: 0,
    });
    return this.toPublic(updated);
  }

  async listPayments(input?: {
    q?: string;
    planId?: string;
    status?: string;
    from?: string;
    to?: string;
  }) {
    const filters = [];
    const from = parseDayStart(input?.from);
    const to = parseDayEnd(input?.to);
    if (input?.planId) filters.push(eq(payments.planId, input.planId));
    if (from) filters.push(gte(payments.paidAt, from));
    if (to) filters.push(lte(payments.paidAt, to));
    if (input?.q) {
      const q = `%${input.q.trim().toLowerCase()}%`;
      const nameIds = await this.profileIdsMatchingName(q);
      const matchingSubs =
        nameIds.length > 0
          ? await this.db
              .select({ id: subscriptions.id })
              .from(subscriptions)
              .where(inArray(subscriptions.userId, nameIds))
          : [];
      const subIds = matchingSubs.map((row) => row.id);
      filters.push(
        or(
          ilike(payments.email, q),
          ilike(payments.pineOrderId, q),
          ...(subIds.length ? [inArray(payments.subscriptionId, subIds)] : []),
        ),
      );
    }

    const payRows = await this.db
      .select()
      .from(payments)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(payments.paidAt))
      .limit(1000);

    const kindFiltered = payRows.filter((item) => {
      if (item.status !== 'paid' && item.status !== 'granted') return false;
      const kind = paymentKind(item);
      if (input?.status === 'paid') return kind === 'paid';
      if (input?.status === 'granted') return kind === 'granted';
      return true;
    });

    const subIds = [
      ...new Set(kindFiltered.map((item) => item.subscriptionId).filter((id): id is string => Boolean(id))),
    ];
    const subRows = subIds.length
      ? await this.db.select().from(subscriptions).where(inArray(subscriptions.id, subIds))
      : [];
    const subById = new Map(subRows.map((row) => [row.id, row]));
    const profileByUserId = await this.profilesByUserIds(subRows.map((row) => row.userId));

    let collectedPaise = 0;
    let grantedPaise = 0;
    let orderCount = 0;
    const payerEmails = new Set<string>();

    const list: AdminPaymentRow[] = kindFiltered.slice(0, 500).map((item) => {
      const kind = paymentKind(item);
      const plan = getPricingPlan(item.planId);
      const sub = item.subscriptionId ? subById.get(item.subscriptionId) : undefined;
      const profile = sub?.userId ? profileByUserId.get(sub.userId) : undefined;
      return {
        id: item.id,
        subscriptionId: item.subscriptionId,
        email: item.email,
        fullName: profile?.fullName ?? null,
        avatarUrl: profile?.avatarUrl ?? null,
        planId: item.planId,
        planName: plan?.name || item.planId,
        amountPaise: item.amountPaise,
        currency: item.currency,
        pineOrderId: item.pineOrderId,
        status: kind,
        paidAt: item.paidAt.toISOString(),
      };
    });

    for (const item of kindFiltered) {
      const kind = paymentKind(item);
      if (kind === 'granted') {
        grantedPaise += item.amountPaise;
        continue;
      }
      collectedPaise += item.amountPaise;
      orderCount += 1;
      payerEmails.add(item.email);
    }

    return {
      payments: list,
      totals: {
        collectedPaise,
        grantedPaise,
        orderCount,
        uniquePayers: payerEmails.size,
      },
    };
  }
}
