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

export const subscriptionEvents = pgTable(
  'subscription_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id, {
      onDelete: 'cascade',
    }),
    email: text('email').notNull(),
    planId: text('plan_id').notNull(),
    action: text('action').notNull(),
    startsAt: timestamp('starts_at'),
    expiresAt: timestamp('expires_at'),
    amountPaise: integer('amount_paise'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('subscription_events_sub_idx').on(t.subscriptionId, t.createdAt),
    index('subscription_events_email_idx').on(t.email),
  ],
);

export const coachNotes = pgTable('coach_notes', {
  subscriptionId: uuid('subscription_id')
    .primaryKey()
    .references(() => subscriptions.id, { onDelete: 'cascade' })
    .notNull(),
  body: text('body').default('').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const coachCheckins = pgTable(
  'coach_checkins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subscriptionId: uuid('subscription_id')
      .references(() => subscriptions.id, { onDelete: 'cascade' })
      .notNull(),
    email: text('email').notNull(),
    checkinDate: text('checkin_date').notNull(),
    weight: text('weight'),
    adherence: text('adherence'),
    clientUpdate: text('client_update'),
    coachReply: text('coach_reply'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [index('coach_checkins_sub_idx').on(t.subscriptionId, t.createdAt)],
);

export const userAppSync = pgTable('user_app_sync', {
  userId: uuid('user_id').primaryKey().notNull(),
  payload: text('payload').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const exerciseCategories = pgTable('exercise_categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  icon: text('icon'),
});

export const exercises = pgTable(
  'exercises',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    instructions: text('instructions'),
    categoryId: uuid('category_id'),
    muscleGroup: text('muscle_group').notNull(),
    targetMuscle: text('target_muscle').notNull(),
    secondaryMuscles: text('secondary_muscles'),
    anatomyView: text('anatomy_view'),
    anatomyPrimary: text('anatomy_primary'),
    anatomySecondary: text('anatomy_secondary'),
    equipment: text('equipment'),
    difficulty: text('difficulty'),
    imageUrl: text('image_url'),
    videoUrl: text('video_url'),
    userId: uuid('user_id'),
  },
  (t) => [uniqueIndex('exercises_slug_uidx').on(t.slug)],
);
