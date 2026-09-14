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
      useFactory: () => {
        const url = process.env.DATABASE_URL?.trim();
        if (!url || /USER:PASSWORD|localhost:5432\/hybridpro/.test(url)) {
          throw new Error(
            'DATABASE_URL is missing. Copy it from Hybrid Pro Mobile App/.env.local into hybrid-pro-api/.env',
          );
        }
        const client = postgres(url, { prepare: false, ssl: 'require' });
        return drizzle(client, { schema });
      },
    },
  ],
  exports: [DB],
})
export class DbModule {}
