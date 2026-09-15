import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey().notNull(),
  fullName: text('full_name'),
  avatarUrl: text('avatar_url'),
  experienceLevel: text('experience_level'),
  updatedAt: timestamp('updated_at'),
});

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

export const contactSubmissions = pgTable(
  'contact_submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    phone: text('phone'),
    goal: text('goal').notNull(),
    status: text('status').default('new').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [index('contact_submissions_created_idx').on(t.createdAt), index('contact_submissions_email_idx').on(t.email)],
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
