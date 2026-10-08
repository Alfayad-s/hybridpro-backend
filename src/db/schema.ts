import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

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
    appleSub: text('apple_sub'),
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
    uniqueIndex('member_accounts_apple_sub_uidx').on(t.appleSub),
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

/** Weekly hours the coach can be booked. Minutes are from midnight in Asia/Kolkata. */
export const coachAvailability = pgTable(
  'coach_availability',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    weekday: integer('weekday').notNull(),
    startMinute: integer('start_minute').notNull(),
    endMinute: integer('end_minute').notNull(),
  },
  (t) => [index('coach_availability_weekday_idx').on(t.weekday)],
);

/** One-off ranges when the coach cannot be booked. */
export const coachTimeOff = pgTable(
  'coach_time_off',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    startsAt: timestamp('starts_at').notNull(),
    endsAt: timestamp('ends_at').notNull(),
  },
  (t) => [index('coach_time_off_range_idx').on(t.startsAt, t.endsAt)],
);

export const sessionBookings = pgTable(
  'session_bookings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subscriptionId: uuid('subscription_id')
      .references(() => subscriptions.id, { onDelete: 'cascade' })
      .notNull(),
    userId: uuid('user_id'),
    email: text('email').notNull(),
    startsAt: timestamp('starts_at').notNull(),
    endsAt: timestamp('ends_at').notNull(),
    status: text('status').default('booked').notNull(),
    bookedBy: text('booked_by').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('session_bookings_sub_idx').on(t.subscriptionId, t.startsAt),
    index('session_bookings_status_idx').on(t.status, t.startsAt),
  ],
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
    library: text('library').notNull().default('workout'),
  },
  (t) => [uniqueIndex('exercises_slug_uidx').on(t.slug)],
);

export const mealLibrary = pgTable(
  'meal_library',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    type: text('type').notNull().default('lunch'),
    calories: integer('calories').notNull().default(0),
    proteinG: integer('protein_g').notNull().default(0),
    carbsG: integer('carbs_g').notNull().default(0),
    fatG: integer('fat_g').notNull().default(0),
    notes: text('notes'),
    imageUrl: text('image_url'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [index('meal_library_type_idx').on(t.type, t.name)],
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
    deviceId: text('device_id'),
    lastActiveAt: timestamp('last_active_at'),
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

/** One shared Hyrox room. Messages are not tied to a private coach conversation. */
export const hyroxMessages = pgTable(
  'hyrox_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    senderRole: text('sender_role').notNull(),
    senderUserId: uuid('sender_user_id'),
    senderName: text('sender_name').notNull(),
    senderCoachEmail: text('sender_coach_email'),
    body: text('body').notNull(),
    imageUrl: text('image_url'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [index('hyrox_messages_created_idx').on(t.createdAt)],
);

export const hyroxReads = pgTable('hyrox_reads', {
  userId: text('user_id').primaryKey().notNull(),
  lastReadAt: timestamp('last_read_at').notNull(),
});

/** Hybrid Pro store catalog (plans + merch). */
export const storeCategories = pgTable(
  'store_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    label: text('label').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    active: boolean('active').notNull().default(true),
    comingSoon: boolean('coming_soon').notNull().default(false),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [uniqueIndex('store_categories_slug_uidx').on(t.slug)],
);

export const storeKinds = pgTable(
  'store_kinds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    label: text('label').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [uniqueIndex('store_kinds_slug_uidx').on(t.slug)],
);

export const storeProducts = pgTable(
  'store_products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    subtitle: text('subtitle').notNull().default(''),
    description: text('description'),
    /** slug from store_categories, e.g. plans | tees */
    category: text('category').notNull(),
    /** slug from store_kinds, e.g. plan | merch */
    kind: text('kind').notNull().default('merch'),
    priceLabel: text('price_label').notNull(),
    pricePaise: integer('price_paise'),
    /** Coin redeem price; null = cash-only */
    coinPrice: integer('coin_price'),
    imageUrl: text('image_url'),
    /** JSON array of size strings, e.g. ["S","M","L"] */
    sizes: text('sizes'),
    planId: text('plan_id'),
    active: boolean('active').notNull().default(true),
    comingSoon: boolean('coming_soon').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('store_products_slug_uidx').on(t.slug),
    index('store_products_category_idx').on(t.category),
    index('store_products_active_idx').on(t.active),
  ],
);

/** Website /shop top banners and between-card promo tiles. */
export const shopPromos = pgTable(
  'shop_promos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** banner = top stack, card = masonry tile between products */
    placement: text('placement').notNull(),
    imageUrl: text('image_url').notNull(),
    alt: text('alt').notNull().default(''),
    /** Short chip on a banner. Unused for card tiles. */
    label: text('label').notNull().default(''),
    /** Shop category slug. Empty means a tap does not filter. */
    category: text('category').notNull().default(''),
    active: boolean('active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('shop_promos_placement_idx').on(t.placement),
    index('shop_promos_active_idx').on(t.active),
  ],
);

/** Website shop checkout. pending until the success page confirms payment. */
export const shopOrders = pgTable(
  'shop_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reference: text('reference').notNull(),
    pineOrderId: text('pine_order_id').notNull().default(''),
    status: text('status').notNull().default('pending'),
    customerName: text('customer_name').notNull().default(''),
    email: text('email').notNull().default(''),
    mobile: text('mobile').notNull().default(''),
    floor: text('floor').notNull().default(''),
    address: text('address').notNull().default(''),
    city: text('city').notNull().default(''),
    pincode: text('pincode').notNull().default(''),
    itemsJson: text('items_json').notNull().default('[]'),
    amountPaise: integer('amount_paise').notNull().default(0),
    rejectReason: text('reject_reason').notNull().default(''),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('shop_orders_reference_uidx').on(t.reference),
    index('shop_orders_created_idx').on(t.createdAt),
  ],
);

/** Member XP / coins / challenge streak / badges. */
export const userRewards = pgTable(
  'user_rewards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    level: integer('level').notNull().default(1),
    xp: integer('xp').notNull().default(0),
    coins: integer('coins').notNull().default(0),
    currentStreak: integer('current_streak').notNull().default(0),
    longestStreak: integer('longest_streak').notNull().default(0),
    lastCompletedDate: text('last_completed_date'),
    badges: text('badges').notNull().default('[]'),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [uniqueIndex('user_rewards_user_uidx').on(t.userId)],
);

/** Daily / weekly / monthly challenge instances. */
export const dailyChallenges = pgTable(
  'daily_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    date: text('date').notNull(),
    period: text('period').notNull().default('daily'),
    title: text('title').notNull(),
    description: text('description').notNull(),
    category: text('category').notNull(),
    difficulty: text('difficulty').notNull(),
    targetValue: text('target_value').notNull(),
    currentValue: text('current_value').notNull().default('0'),
    unit: text('unit').notNull(),
    status: text('status').notNull().default('pending'),
    xpReward: integer('xp_reward').notNull(),
    coinReward: integer('coin_reward').notNull(),
    badgeReward: text('badge_reward'),
    icon: text('icon'),
    color: text('color'),
    autoComplete: boolean('auto_complete').notNull().default(false),
    completedAt: timestamp('completed_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('daily_challenges_user_date_idx').on(t.userId, t.date),
    index('daily_challenges_user_status_idx').on(t.userId, t.status),
  ],
);

export const challengeHistory = pgTable(
  'challenge_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    challengeId: uuid('challenge_id')
      .references(() => dailyChallenges.id, { onDelete: 'cascade' })
      .notNull(),
    completedAt: timestamp('completed_at').defaultNow().notNull(),
    xpEarned: integer('xp_earned').notNull(),
    coinsEarned: integer('coins_earned').notNull(),
  },
  (t) => [index('challenge_history_user_idx').on(t.userId, t.completedAt)],
);

/** Append-only coin earn/spend ledger. */
export const coinLedger = pgTable(
  'coin_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    delta: integer('delta').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    reason: text('reason').notNull(),
    refType: text('ref_type'),
    refId: text('ref_id'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [index('coin_ledger_user_idx').on(t.userId, t.createdAt)],
);

/** Store product claims paid with coins. */
export const coinRedemptions = pgTable(
  'coin_redemptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    productId: uuid('product_id')
      .references(() => storeProducts.id, { onDelete: 'restrict' })
      .notNull(),
    coinsSpent: integer('coins_spent').notNull(),
    size: text('size'),
    status: text('status').notNull().default('pending'),
    notes: text('notes'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('coin_redemptions_user_idx').on(t.userId, t.createdAt),
    index('coin_redemptions_status_idx').on(t.status),
  ],
);

/** Clocks the member confirmed. Null clocks mean "use the engine default". */
export const memberRoutines = pgTable('member_routines', {
  userId: uuid('user_id').primaryKey().notNull(),
  timezone: text('timezone').notNull().default('Asia/Kolkata'),
  wakeMinutes: integer('wake_minutes'),
  gymMinutes: integer('gym_minutes'),
  breakfastMinutes: integer('breakfast_minutes'),
  lunchMinutes: integer('lunch_minutes'),
  dinnerMinutes: integer('dinner_minutes'),
  sleepMinutes: integer('sleep_minutes'),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/** Per-member overrides. Null quiet hours mean "use the global window". */
export const engagementPreferences = pgTable('engagement_preferences', {
  userId: uuid('user_id').primaryKey().notNull(),
  workout: boolean('workout').notNull().default(true),
  meals: boolean('meals').notNull().default(true),
  hydration: boolean('hydration').notNull().default(true),
  sleep: boolean('sleep').notNull().default(true),
  motivation: boolean('motivation').notNull().default(true),
  streak: boolean('streak').notNull().default(true),
  quietStartMinutes: integer('quiet_start_minutes'),
  quietEndMinutes: integer('quiet_end_minutes'),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/** One global row. Member preferences override these. */
export const engagementSettings = pgTable('engagement_settings', {
  id: text('id').primaryKey().notNull().default('default'),
  dailyLimit: integer('daily_limit').notNull().default(6),
  quietStartMinutes: integer('quiet_start_minutes').notNull().default(22 * 60 + 30),
  quietEndMinutes: integer('quiet_end_minutes').notNull().default(7 * 60),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/** Admin-editable copy. Seeded from the fixed catalog; restarts do not overwrite edits. */
export const notificationTemplates = pgTable('notification_templates', {
  type: text('type').primaryKey().notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  deepLink: text('deep_link').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  priority: text('priority').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/**
 * Claim log for engagement pushes. One SEND per member, type, local date, and
 * occurrence (hydration may use 2). A retry that inserts again does not send.
 */
export const notificationLogs = pgTable(
  'notification_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    type: text('type').notNull(),
    localDate: text('local_date').notNull(),
    occurrence: integer('occurrence').notNull().default(1),
    result: text('result').notNull().default('SEND'),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('notification_logs_send_uidx').on(t.userId, t.type, t.localDate, t.occurrence),
    index('notification_logs_user_day_idx').on(t.userId, t.localDate),
  ],
);

/** Member actions used later for suggestions. Not a copy of workouts or meals. */
export const engagementEvents = pgTable(
  'engagement_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    type: text('type').notNull(),
    localDate: text('local_date'),
    payload: text('payload'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [index('engagement_events_user_idx').on(t.userId, t.createdAt)],
);
