// DATABASE_URL=postgres://… selects PostgreSQL (+PostGIS when installed);
// otherwise a local SQLite file is used.
//
// Handle API (all async):  all(sql, params) -> rows   get(sql, params) -> row
//                          run(sql, params) -> { changes }   tx(async (t) => …)
// Write SQL with `?` placeholders and `RETURNING id` for inserts.
import path from 'node:path';
import { createSqlite } from './sqlite.js';
import { createPostgres } from './postgres.js';

const url = process.env.DATABASE_URL;

export const db = url?.startsWith('postgres')
  ? createPostgres(url)
  : createSqlite(process.env.DB_PATH || path.join(import.meta.dirname, '..', '..', 'data', 'food.db'));

export const nowIso = () => new Date().toISOString();
