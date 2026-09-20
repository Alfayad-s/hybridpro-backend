import { Global, Module } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export const DB = Symbol('DB');

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
        const client = postgres(url, {
          prepare: false,
          ssl: 'require',
          max: 4,
        });
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
        return drizzle(client, { schema });
      },
    },
  ],
  exports: [DB],
})
export class DbModule {}
