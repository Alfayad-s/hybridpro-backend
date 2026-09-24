import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey().notNull(),
  fullName: text('full_name'),
  avatarUrl: text('avatar_url'),
  experienceLevel: text('experience_level'),
  assessmentStatus: text('assessment_status'),
  assessmentJson: text('assessment_json'),
  updatedAt: timestamp('updated_at'),
});

/** Hybrid Pro member accounts created via Nest Google auth (not Supabase Auth). */
export const memberAccounts = pgTable(
  'member_accounts',
  {
    id: uuid('id').primaryKey().notNull(),
    email: text('email').notNull(),
    googleSub: text('google_sub'),
    fullName: text('full_name'),
    avatarUrl: text('avatar_url'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    // Case-insensitive uniqueness is enforced in SQL migration
    // (lower(trim(email))); drizzle keeps a nominal unique on email.
    uniqueIndex('member_accounts_email_lower_uidx').on(t.email),
    uniqueIndex('member_accounts_google_sub_uidx').on(t.googleSub),
  ],
);

/** Short-lived email OTP challenges for Nest member login. */
export const emailOtps = pgTable('email_otps', {
  email: text('email').primaryKey().notNull(),
  codeHash: text('code_hash').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  attempts: integer('attempts').default(0).notNull(),
  sentAt: timestamp('sent_at').defaultNow().notNull(),
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

export const deviceTokens = pgTable(
  'device_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    role: text('role').notNull(),
    userId: uuid('user_id'),
    coachEmail: text('coach_email'),
    token: text('token').notNull(),
    platform: text('platform').notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('device_tokens_token_uidx').on(t.token),
    index('device_tokens_member_idx').on(t.role, t.userId),
    index('device_tokens_coach_idx').on(t.role, t.coachEmail),
  ],
);

export const gymSessions = pgTable(
  'gym_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subscriptionId: uuid('subscription_id')
      .references(() => subscriptions.id, { onDelete: 'cascade' })
      .notNull(),
    userId: uuid('user_id').notNull(),
    checkedInAt: timestamp('checked_in_at').defaultNow().notNull(),
    checkedOutAt: timestamp('checked_out_at'),
    status: text('status').default('open').notNull(),
  },
  (t) => [
    index('gym_sessions_user_idx').on(t.userId),
    index('gym_sessions_sub_idx').on(t.subscriptionId),
    index('gym_sessions_status_idx').on(t.status),
  ],
);

export const coachConversations = pgTable(
  'coach_conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subscriptionId: uuid('subscription_id')
      .references(() => subscriptions.id, { onDelete: 'cascade' })
      .notNull(),
    memberUserId: uuid('member_user_id').notNull(),
    lastMessageAt: timestamp('last_message_at'),
    memberLastReadAt: timestamp('member_last_read_at'),
    coachLastReadAt: timestamp('coach_last_read_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('coach_conversations_sub_uidx').on(t.subscriptionId),
    index('coach_conversations_member_idx').on(t.memberUserId),
    index('coach_conversations_last_msg_idx').on(t.lastMessageAt),
  ],
);

export const coachMessages = pgTable(
  'coach_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .references(() => coachConversations.id, { onDelete: 'cascade' })
      .notNull(),
    senderRole: text('sender_role').notNull(),
    senderUserId: uuid('sender_user_id'),
    senderCoachEmail: text('sender_coach_email'),
    body: text('body').notNull(),
    imageUrl: text('image_url'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [index('coach_messages_conv_created_idx').on(t.conversationId, t.createdAt)],
);
