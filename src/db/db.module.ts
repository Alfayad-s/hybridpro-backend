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
            updated_at timestamp
          )
        `;
        return drizzle(client, { schema });
      },
    },
  ],
  exports: [DB],
})
export class DbModule {}
