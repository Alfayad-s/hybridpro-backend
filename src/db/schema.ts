import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id'),
    email: text('email').notNull(),
    mobile: text('mobile'),
    planId: text('plan_id').notNull(),
    nextPlanId: text('next_plan_id'),
    status: text('status').default('pending').notNull(),
    startsAt: timestamp('starts_at'),
    expiresAt: timestamp('expires_at'),
    pineOrderId: text('pine_order_id'),
    merchantOrderReference: text('merchant_order_reference'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    uniqueIndex('subscriptions_pine_order_uidx').on(t.pineOrderId),
    uniqueIndex('subscriptions_merchant_ref_uidx').on(t.merchantOrderReference),
    index('subscriptions_email_idx').on(t.email),
    index('subscriptions_user_idx').on(t.userId),
  ],
);

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id, {
      onDelete: 'cascade',
    }),
    email: text('email').notNull(),
    planId: text('plan_id').notNull(),
    amountPaise: integer('amount_paise').notNull(),
    currency: text('currency').default('INR').notNull(),
    pineOrderId: text('pine_order_id'),
    status: text('status').default('paid').notNull(),
    paidAt: timestamp('paid_at').defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('payments_pine_order_uidx').on(t.pineOrderId),
    index('payments_email_idx').on(t.email),
  ],
);
