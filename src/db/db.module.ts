import { Global, Module } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { DEFAULT_TEMPLATES, NOTIFICATION_TYPES } from '../engagement/templates.js';
import { DEFAULT_DAILY_LIMIT, DEFAULT_QUIET_END, DEFAULT_QUIET_START } from '../engagement/rules.js';
import * as schema from './schema.js';

export const DB = Symbol('DB');

/**
 * Supabase's transaction pooler (port 6543) drops replies when postgres.js
 * sends several queries on one connection at once. Requests then hang until
 * the phone gives up. The session pooler (port 5432) on the same host keeps
 * one server connection per client and answers every query.
 */
function sessionPoolerUrl(raw: string) {
  try {
    const parsed = new URL(raw);
    if (parsed.hostname.endsWith('.pooler.supabase.com') && parsed.port === '6543') {
      parsed.port = '5432';
      return parsed.toString();
    }
  } catch {
    /* keep the original string if it is not a URL */
  }
  return raw;
}

@Global()
@Module({
  providers: [
    {
      provide: DB,
      useFactory: async () => {
        const url = process.env.DATABASE_URL?.trim();
        if (!url || /USER:PASSWORD|localhost:5432\/hybridpro/.test(url)) {
          throw new Error(
            'DATABASE_URL is missing. Copy it from Hybrid Pro Mobile App/.env.local into hybrid-pro-api/.env',
          );
        }
        const client = postgres(sessionPoolerUrl(url), {
          prepare: false,
          ssl: 'require',
          max: 4,
          connect_timeout: 10,
          idle_timeout: 20,
          max_lifetime: 60 * 10,
          onnotice: () => {},
        });
        // Bump when the statements below change. A matching stamp skips them on the next boot.
        const schemaVersion = '20260930-sessions-2';
        await client`
          CREATE TABLE IF NOT EXISTS app_schema (
            id integer PRIMARY KEY,
            version text NOT NULL
          )
        `;
        const stamped = await client<{ version: string }[]>`
          SELECT version FROM app_schema WHERE id = 1
        `;
        if (stamped[0]?.version !== schemaVersion) {
          await client`
            CREATE TABLE IF NOT EXISTS coach_availability (
              id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
              weekday integer NOT NULL,
              start_minute integer NOT NULL,
              end_minute integer NOT NULL
            )
          `;
          await client`CREATE INDEX IF NOT EXISTS coach_availability_weekday_idx ON coach_availability (weekday)`;
          await client`
            CREATE TABLE IF NOT EXISTS coach_time_off (
              id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
              starts_at timestamp NOT NULL,
              ends_at timestamp NOT NULL
            )
          `;
          await client`CREATE INDEX IF NOT EXISTS coach_time_off_range_idx ON coach_time_off (starts_at, ends_at)`;
          await client`
            CREATE TABLE IF NOT EXISTS session_bookings (
              id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
              subscription_id uuid REFERENCES subscriptions(id) ON DELETE CASCADE NOT NULL,
              user_id uuid,
              email text NOT NULL,
              starts_at timestamp NOT NULL,
              ends_at timestamp NOT NULL,
              status text NOT NULL DEFAULT 'booked',
              booked_by text NOT NULL,
              created_at timestamp DEFAULT now() NOT NULL
            )
          `;
          await client`CREATE INDEX IF NOT EXISTS session_bookings_sub_idx ON session_bookings (subscription_id, starts_at)`;
          await client`CREATE INDEX IF NOT EXISTS session_bookings_status_idx ON session_bookings (status, starts_at)`;
          await client`
            CREATE UNIQUE INDEX IF NOT EXISTS session_bookings_start_booked_uidx
            ON session_bookings (starts_at)
            WHERE status = 'booked'
          `;
        }
        if (stamped[0]?.version === schemaVersion) {
          return drizzle(client, { schema });
        }
        // Production already has these tables. Replaying every CREATE on boot
        // keeps the API from listening, so the app spinner waits.
        const [existing] = await client<{ rel: string | null }[]>`
          SELECT to_regclass('public.engagement_events') AS rel
        `;
        if (existing?.rel) {
          await client`
            INSERT INTO app_schema (id, version)
            VALUES (1, ${schemaVersion})
            ON CONFLICT (id) DO UPDATE SET version = ${schemaVersion}
          `;
          return drizzle(client, { schema });
        }
        await client`
          CREATE TABLE IF NOT EXISTS subscription_events (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            subscription_id uuid REFERENCES subscriptions(id) ON DELETE CASCADE,
            email text NOT NULL,
            plan_id text NOT NULL,
            action text NOT NULL,
            starts_at timestamp,
            expires_at timestamp,
            amount_paise integer,
            created_at timestamp DEFAULT now() NOT NULL
          )
        `;
        await client`CREATE INDEX IF NOT EXISTS subscription_events_sub_idx ON subscription_events (subscription_id, created_at)`;
        await client`CREATE INDEX IF NOT EXISTS subscription_events_email_idx ON subscription_events (email)`;
        await client`
          CREATE TABLE IF NOT EXISTS profiles (
            id uuid PRIMARY KEY NOT NULL,
            full_name text,
            avatar_url text,
            experience_level text,
            assessment_status text,
            assessment_json text,
            updated_at timestamp
          )
        `;
        await client`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS assessment_status text`;
        await client`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS assessment_json text`;
        await client`
          CREATE TABLE IF NOT EXISTS member_accounts (
            id uuid PRIMARY KEY NOT NULL,
            email text NOT NULL,
            google_sub text,
            full_name text,
            avatar_url text,
            created_at timestamp DEFAULT now() NOT NULL,
            updated_at timestamp DEFAULT now() NOT NULL
          )
        `;
        // Email is the shared identity for Google + OTP — case-insensitive unique.
        await client`DROP INDEX IF EXISTS member_accounts_email_uidx`;
        await client`CREATE UNIQUE INDEX IF NOT EXISTS member_accounts_email_lower_uidx ON member_accounts (lower(trim(email)))`;
        await client`DROP INDEX IF EXISTS member_accounts_google_sub_uidx`;
        await client`CREATE UNIQUE INDEX IF NOT EXISTS member_accounts_google_sub_uidx ON member_accounts (google_sub) WHERE google_sub IS NOT NULL`;
        await client`UPDATE member_accounts SET email = lower(trim(email)) WHERE email <> lower(trim(email))`;
        await client`
          CREATE TABLE IF NOT EXISTS email_otps (
            email text PRIMARY KEY NOT NULL,
            code_hash text NOT NULL,
            expires_at timestamp NOT NULL,
            attempts integer DEFAULT 0 NOT NULL,
            sent_at timestamp DEFAULT now() NOT NULL
          )
        `;
        await client`
          CREATE TABLE IF NOT EXISTS coach_notes (
            subscription_id uuid PRIMARY KEY REFERENCES subscriptions(id) ON DELETE CASCADE,
            body text NOT NULL DEFAULT '',
            updated_at timestamp DEFAULT now() NOT NULL
          )
        `;
        await client`
          CREATE TABLE IF NOT EXISTS coach_checkins (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            subscription_id uuid REFERENCES subscriptions(id) ON DELETE CASCADE NOT NULL,
            email text NOT NULL,
            checkin_date text NOT NULL,
            weight text,
            adherence text,
            client_update text,
            coach_reply text,
            created_at timestamp DEFAULT now() NOT NULL
          )
        `;
        await client`CREATE INDEX IF NOT EXISTS coach_checkins_sub_idx ON coach_checkins (subscription_id, created_at)`;
        await client`
          CREATE TABLE IF NOT EXISTS coach_availability (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            weekday integer NOT NULL,
            start_minute integer NOT NULL,
            end_minute integer NOT NULL
          )
        `;
        await client`CREATE INDEX IF NOT EXISTS coach_availability_weekday_idx ON coach_availability (weekday)`;
        await client`
          CREATE TABLE IF NOT EXISTS coach_time_off (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            starts_at timestamp NOT NULL,
            ends_at timestamp NOT NULL
          )
        `;
        await client`CREATE INDEX IF NOT EXISTS coach_time_off_range_idx ON coach_time_off (starts_at, ends_at)`;
        await client`
          CREATE TABLE IF NOT EXISTS session_bookings (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            subscription_id uuid REFERENCES subscriptions(id) ON DELETE CASCADE NOT NULL,
            user_id uuid,
            email text NOT NULL,
            starts_at timestamp NOT NULL,
            ends_at timestamp NOT NULL,
            status text NOT NULL DEFAULT 'booked',
            booked_by text NOT NULL,
            created_at timestamp DEFAULT now() NOT NULL
          )
        `;
        await client`CREATE INDEX IF NOT EXISTS session_bookings_sub_idx ON session_bookings (subscription_id, starts_at)`;
        await client`CREATE INDEX IF NOT EXISTS session_bookings_status_idx ON session_bookings (status, starts_at)`;
        await client`
          CREATE UNIQUE INDEX IF NOT EXISTS session_bookings_start_booked_uidx
          ON session_bookings (starts_at)
          WHERE status = 'booked'
        `;
        await client`
          CREATE TABLE IF NOT EXISTS exercise_categories (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            name text NOT NULL UNIQUE,
            icon text
          )
        `;
        await client`
          CREATE TABLE IF NOT EXISTS exercises (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            slug text NOT NULL UNIQUE,
            name text NOT NULL,
            description text,
            instructions text,
            category_id uuid,
            muscle_group text NOT NULL,
            target_muscle text NOT NULL,
            secondary_muscles text,
            anatomy_view text,
            anatomy_primary text,
            anatomy_secondary text,
            equipment text,
            difficulty text,
            image_url text,
            video_url text,
            user_id uuid
          )
        `;
        await client`CREATE UNIQUE INDEX IF NOT EXISTS exercises_slug_uidx ON exercises (slug)`;
        await client`
          CREATE TABLE IF NOT EXISTS user_app_sync (
            user_id uuid PRIMARY KEY NOT NULL,
            payload text NOT NULL,
            updated_at timestamp DEFAULT now() NOT NULL
          )
        `;
        await client`
          CREATE TABLE IF NOT EXISTS device_tokens (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            role text NOT NULL,
            user_id uuid,
            coach_email text,
            token text NOT NULL,
            platform text NOT NULL,
            updated_at timestamp DEFAULT now() NOT NULL
          )
        `;
        await client`CREATE UNIQUE INDEX IF NOT EXISTS device_tokens_token_uidx ON device_tokens (token)`;
        await client`CREATE INDEX IF NOT EXISTS device_tokens_member_idx ON device_tokens (role, user_id)`;
        await client`CREATE INDEX IF NOT EXISTS device_tokens_coach_idx ON device_tokens (role, coach_email)`;
        await client`
          CREATE TABLE IF NOT EXISTS gym_sessions (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            subscription_id uuid REFERENCES subscriptions(id) ON DELETE CASCADE NOT NULL,
            user_id uuid NOT NULL,
            checked_in_at timestamp DEFAULT now() NOT NULL,
            checked_out_at timestamp,
            status text NOT NULL DEFAULT 'open'
          )
        `;
        await client`CREATE INDEX IF NOT EXISTS gym_sessions_user_idx ON gym_sessions (user_id)`;
        await client`CREATE INDEX IF NOT EXISTS gym_sessions_sub_idx ON gym_sessions (subscription_id)`;
        await client`CREATE INDEX IF NOT EXISTS gym_sessions_status_idx ON gym_sessions (status)`;
        await client`
          CREATE UNIQUE INDEX IF NOT EXISTS gym_sessions_one_open_per_user
          ON gym_sessions (user_id)
          WHERE status = 'open'
        `;
        await client`
          CREATE TABLE IF NOT EXISTS coach_conversations (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            subscription_id uuid REFERENCES subscriptions(id) ON DELETE CASCADE NOT NULL,
            member_user_id uuid NOT NULL,
            last_message_at timestamp,
            member_last_read_at timestamp,
            coach_last_read_at timestamp,
            created_at timestamp DEFAULT now() NOT NULL
          )
        `;
        await client`CREATE UNIQUE INDEX IF NOT EXISTS coach_conversations_sub_uidx ON coach_conversations (subscription_id)`;
        await client`CREATE INDEX IF NOT EXISTS coach_conversations_member_idx ON coach_conversations (member_user_id)`;
        await client`CREATE INDEX IF NOT EXISTS coach_conversations_last_msg_idx ON coach_conversations (last_message_at)`;
        await client`
          CREATE TABLE IF NOT EXISTS coach_messages (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            conversation_id uuid REFERENCES coach_conversations(id) ON DELETE CASCADE NOT NULL,
            sender_role text NOT NULL,
            sender_user_id uuid,
            sender_coach_email text,
            body text NOT NULL,
            image_url text,
            created_at timestamp DEFAULT now() NOT NULL
          )
        `;
        await client`CREATE INDEX IF NOT EXISTS coach_messages_conv_created_idx ON coach_messages (conversation_id, created_at)`;
        await client`
          CREATE TABLE IF NOT EXISTS store_categories (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            slug text NOT NULL UNIQUE,
            label text NOT NULL,
            sort_order integer NOT NULL DEFAULT 0,
            active boolean NOT NULL DEFAULT true,
            created_at timestamp DEFAULT now() NOT NULL,
            updated_at timestamp DEFAULT now() NOT NULL
          )
        `;
        await client`CREATE UNIQUE INDEX IF NOT EXISTS store_categories_slug_uidx ON store_categories (slug)`;
        await client`
          CREATE TABLE IF NOT EXISTS store_kinds (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            slug text NOT NULL UNIQUE,
            label text NOT NULL,
            sort_order integer NOT NULL DEFAULT 0,
            active boolean NOT NULL DEFAULT true,
            created_at timestamp DEFAULT now() NOT NULL,
            updated_at timestamp DEFAULT now() NOT NULL
          )
        `;
        await client`CREATE UNIQUE INDEX IF NOT EXISTS store_kinds_slug_uidx ON store_kinds (slug)`;
        await client`
          CREATE TABLE IF NOT EXISTS store_products (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            slug text NOT NULL UNIQUE,
            title text NOT NULL,
            subtitle text NOT NULL DEFAULT '',
            description text,
            category text NOT NULL,
            kind text NOT NULL DEFAULT 'merch',
            price_label text NOT NULL,
            price_paise integer,
            image_url text,
            sizes text,
            plan_id text,
            active boolean NOT NULL DEFAULT true,
            sort_order integer NOT NULL DEFAULT 0,
            created_at timestamp DEFAULT now() NOT NULL,
            updated_at timestamp DEFAULT now() NOT NULL
          )
        `;
        await client`CREATE UNIQUE INDEX IF NOT EXISTS store_products_slug_uidx ON store_products (slug)`;
        await client`CREATE INDEX IF NOT EXISTS store_products_category_idx ON store_products (category)`;
        await client`CREATE INDEX IF NOT EXISTS store_products_active_idx ON store_products (active)`;
        await client`ALTER TABLE store_products ADD COLUMN IF NOT EXISTS coin_price integer`;
        await client`
          CREATE TABLE IF NOT EXISTS user_rewards (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id uuid NOT NULL,
            level integer NOT NULL DEFAULT 1,
            xp integer NOT NULL DEFAULT 0,
            coins integer NOT NULL DEFAULT 0,
            current_streak integer NOT NULL DEFAULT 0,
            longest_streak integer NOT NULL DEFAULT 0,
            last_completed_date text,
            badges text NOT NULL DEFAULT '[]',
            updated_at timestamp DEFAULT now() NOT NULL
          )
        `;
        await client`CREATE UNIQUE INDEX IF NOT EXISTS user_rewards_user_uidx ON user_rewards (user_id)`;
        await client`
          CREATE TABLE IF NOT EXISTS daily_challenges (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id uuid NOT NULL,
            date text NOT NULL,
            period text NOT NULL DEFAULT 'daily',
            title text NOT NULL,
            description text NOT NULL,
            category text NOT NULL,
            difficulty text NOT NULL,
            target_value text NOT NULL,
            current_value text NOT NULL DEFAULT '0',
            unit text NOT NULL,
            status text NOT NULL DEFAULT 'pending',
            xp_reward integer NOT NULL,
            coin_reward integer NOT NULL,
            badge_reward text,
            icon text,
            color text,
            auto_complete boolean NOT NULL DEFAULT false,
            completed_at timestamp,
            created_at timestamp DEFAULT now() NOT NULL,
            updated_at timestamp DEFAULT now() NOT NULL
          )
        `;
        await client`CREATE INDEX IF NOT EXISTS daily_challenges_user_date_idx ON daily_challenges (user_id, date)`;
        await client`CREATE INDEX IF NOT EXISTS daily_challenges_user_status_idx ON daily_challenges (user_id, status)`;
        await client`
          CREATE TABLE IF NOT EXISTS challenge_history (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id uuid NOT NULL,
            challenge_id uuid REFERENCES daily_challenges(id) ON DELETE CASCADE NOT NULL,
            completed_at timestamp DEFAULT now() NOT NULL,
            xp_earned integer NOT NULL,
            coins_earned integer NOT NULL
          )
        `;
        await client`CREATE INDEX IF NOT EXISTS challenge_history_user_idx ON challenge_history (user_id, completed_at)`;
        await client`
          CREATE TABLE IF NOT EXISTS coin_ledger (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id uuid NOT NULL,
            delta integer NOT NULL,
            balance_after integer NOT NULL,
            reason text NOT NULL,
            ref_type text,
            ref_id text,
            created_at timestamp DEFAULT now() NOT NULL
          )
        `;
        await client`CREATE INDEX IF NOT EXISTS coin_ledger_user_idx ON coin_ledger (user_id, created_at)`;
        await client`
          CREATE TABLE IF NOT EXISTS coin_redemptions (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id uuid NOT NULL,
            product_id uuid REFERENCES store_products(id) ON DELETE RESTRICT NOT NULL,
            coins_spent integer NOT NULL,
            size text,
            status text NOT NULL DEFAULT 'pending',
            notes text,
            created_at timestamp DEFAULT now() NOT NULL,
            updated_at timestamp DEFAULT now() NOT NULL
          )
        `;
        await client`CREATE INDEX IF NOT EXISTS coin_redemptions_user_idx ON coin_redemptions (user_id, created_at)`;
        await client`CREATE INDEX IF NOT EXISTS coin_redemptions_status_idx ON coin_redemptions (status)`;
        await client`
          CREATE TABLE IF NOT EXISTS meal_library (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            name text NOT NULL,
            type text NOT NULL DEFAULT 'lunch',
            calories integer NOT NULL DEFAULT 0,
            protein_g integer NOT NULL DEFAULT 0,
            carbs_g integer NOT NULL DEFAULT 0,
            fat_g integer NOT NULL DEFAULT 0,
            notes text,
            image_url text,
            created_at timestamp DEFAULT now() NOT NULL,
            updated_at timestamp DEFAULT now() NOT NULL
          )
        `;
        await client`CREATE INDEX IF NOT EXISTS meal_library_type_idx ON meal_library (type, name)`;
        await client`ALTER TABLE device_tokens ADD COLUMN IF NOT EXISTS device_id text`;
        await client`ALTER TABLE device_tokens ADD COLUMN IF NOT EXISTS last_active_at timestamp`;
        await client`
          CREATE TABLE IF NOT EXISTS member_routines (
            user_id uuid PRIMARY KEY NOT NULL,
            timezone text NOT NULL DEFAULT 'Asia/Kolkata',
            wake_minutes integer,
            gym_minutes integer,
            breakfast_minutes integer,
            lunch_minutes integer,
            dinner_minutes integer,
            sleep_minutes integer,
            updated_at timestamp DEFAULT now() NOT NULL
          )
        `;
        await client`
          CREATE TABLE IF NOT EXISTS engagement_preferences (
            user_id uuid PRIMARY KEY NOT NULL,
            workout boolean NOT NULL DEFAULT true,
            meals boolean NOT NULL DEFAULT true,
            hydration boolean NOT NULL DEFAULT true,
            sleep boolean NOT NULL DEFAULT true,
            motivation boolean NOT NULL DEFAULT true,
            streak boolean NOT NULL DEFAULT true,
            quiet_start_minutes integer,
            quiet_end_minutes integer,
            updated_at timestamp DEFAULT now() NOT NULL
          )
        `;
        await client`
          CREATE TABLE IF NOT EXISTS engagement_settings (
            id text PRIMARY KEY NOT NULL DEFAULT 'default',
            daily_limit integer NOT NULL DEFAULT 6,
            quiet_start_minutes integer NOT NULL DEFAULT 1350,
            quiet_end_minutes integer NOT NULL DEFAULT 420,
            updated_at timestamp DEFAULT now() NOT NULL
          )
        `;
        await client`
          INSERT INTO engagement_settings (id, daily_limit, quiet_start_minutes, quiet_end_minutes)
          VALUES ('default', ${DEFAULT_DAILY_LIMIT}, ${DEFAULT_QUIET_START}, ${DEFAULT_QUIET_END})
          ON CONFLICT (id) DO NOTHING
        `;
        await client`
          CREATE TABLE IF NOT EXISTS notification_templates (
            type text PRIMARY KEY NOT NULL,
            title text NOT NULL,
            body text NOT NULL,
            deep_link text NOT NULL,
            enabled boolean NOT NULL DEFAULT true,
            priority text NOT NULL,
            updated_at timestamp DEFAULT now() NOT NULL
          )
        `;
        for (const type of NOTIFICATION_TYPES) {
          const template = DEFAULT_TEMPLATES[type];
          await client`
            INSERT INTO notification_templates (type, title, body, deep_link, enabled, priority)
            VALUES (
              ${template.type},
              ${template.title},
              ${template.body},
              ${template.deepLink},
              ${template.enabled},
              ${template.priority}
            )
            ON CONFLICT (type) DO NOTHING
          `;
        }
        await client`
          CREATE TABLE IF NOT EXISTS notification_logs (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id uuid NOT NULL,
            type text NOT NULL,
            local_date text NOT NULL,
            occurrence integer NOT NULL DEFAULT 1,
            result text NOT NULL DEFAULT 'SEND',
            reason text NOT NULL,
            created_at timestamp DEFAULT now() NOT NULL
          )
        `;
        await client`
          CREATE UNIQUE INDEX IF NOT EXISTS notification_logs_send_uidx
          ON notification_logs (user_id, type, local_date, occurrence)
        `;
        await client`
          CREATE INDEX IF NOT EXISTS notification_logs_user_day_idx
          ON notification_logs (user_id, local_date)
        `;
        await client`
          CREATE TABLE IF NOT EXISTS engagement_events (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id uuid NOT NULL,
            type text NOT NULL,
            local_date text,
            payload text,
            created_at timestamp DEFAULT now() NOT NULL
          )
        `;
        await client`
          CREATE INDEX IF NOT EXISTS engagement_events_user_idx
          ON engagement_events (user_id, created_at)
        `;
        await client`
          INSERT INTO app_schema (id, version)
          VALUES (1, ${schemaVersion})
          ON CONFLICT (id) DO UPDATE SET version = ${schemaVersion}
        `;
        return drizzle(client, { schema });
      },
    },
  ],
  exports: [DB],
})
export class DbModule {}
