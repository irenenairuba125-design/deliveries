// SQLite adapter (node:sqlite) for zero-setup development.
// node:sqlite is synchronous and has a single connection, so an async
// transaction would otherwise interleave with other requests' statements.
// A promise lock serialises transactions against all other statements.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { haversineKm } from '../geo.js';

export function createSqlite(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const conn = new DatabaseSync(file);
  conn.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  conn.function('haversine_km', { deterministic: true }, haversineKm);

  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = conn.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  const exec = {
    all: async (sql, params = []) => stmt(sql).all(...params),
    get: async (sql, params = []) => stmt(sql).get(...params),
    run: async (sql, params = []) => ({ changes: Number(stmt(sql).run(...params).changes) }),
  };

  let lock = Promise.resolve();
  const withLock = (fn) => {
    const result = lock.then(fn);
    lock = result.catch(() => {});
    return result;
  };

  return {
    dialect: 'sqlite',
    postgis: false,
    forUpdate: '',
    all: (sql, params) => withLock(() => exec.all(sql, params)),
    get: (sql, params) => withLock(() => exec.get(sql, params)),
    run: (sql, params) => withLock(() => exec.run(sql, params)),
    // Inside fn, use the handle passed in — never the outer db (that would deadlock).
    tx: (fn) =>
      withLock(async () => {
        conn.exec('BEGIN IMMEDIATE');
        try {
          const out = await fn(exec);
          conn.exec('COMMIT');
          return out;
        } catch (err) {
          conn.exec('ROLLBACK');
          throw err;
        }
      }),
    async migrate() {
      conn.exec(fs.readFileSync(new URL('./schema.sqlite.sql', import.meta.url), 'utf8'));
    },
    async close() {
      conn.close();
    },
  };
}
