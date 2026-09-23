// PostgreSQL adapter (production). Queries are written with `?` placeholders
// and rewritten to $1..$n here, so services stay dialect-neutral.
import fs from 'node:fs';
import pg from 'pg';

// Return numbers and ISO strings, matching what the SQLite adapter yields.
pg.types.setTypeParser(20, (v) => Number(v)); // int8 (BIGSERIAL ids, COUNT)
pg.types.setTypeParser(1700, (v) => Number(v)); // numeric
pg.types.setTypeParser(1184, (v) => new Date(v).toISOString()); // timestamptz
pg.types.setTypeParser(1114, (v) => new Date(`${v}Z`).toISOString()); // timestamp

const toPg = (sql) => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};

function wrap(client) {
  return {
    all: async (sql, params = []) => (await client.query(toPg(sql), params)).rows,
    get: async (sql, params = []) => (await client.query(toPg(sql), params)).rows[0],
    run: async (sql, params = []) => ({ changes: (await client.query(toPg(sql), params)).rowCount }),
  };
}

export function createPostgres(connectionString) {
  const pool = new pg.Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX) || 10,
    ssl: process.env.PG_SSL === '1' ? { rejectUnauthorized: process.env.PG_SSL_STRICT !== '0' } : undefined,
  });
  pool.on('error', (err) => console.error('[db] idle client error', err.message));

  const db = {
    dialect: 'postgres',
    postgis: false,
    forUpdate: 'FOR UPDATE',
    ...wrap(pool),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(wrap(client));
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async migrate() {
      await pool.query(fs.readFileSync(new URL('./schema.pg.sql', import.meta.url), 'utf8'));
      db.postgis = await enablePostgis(pool);
    },
    close: () => pool.end(),
  };
  return db;
}

// PostGIS is optional: when present, add geography columns (kept in sync with
// lat/lng automatically) and GiST indexes for index-backed radius queries.
async function enablePostgis(pool) {
  if (process.env.POSTGIS === '0') return false;
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS postgis');
  } catch (err) {
    console.warn(`[db] PostGIS not available (${err.message.split('\n')[0]}); using haversine_km() for radius queries`);
    return false;
  }
  await pool.query(`
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS geog geography(Point, 4326)
      GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography) STORED;
    CREATE INDEX IF NOT EXISTS restaurants_geog_gix ON restaurants USING GIST (geog);
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS geog geography(Point, 4326)
      GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography) STORED;
    CREATE INDEX IF NOT EXISTS drivers_geog_gix ON drivers USING GIST (geog) WHERE is_online = 1;
  `);
  console.log('[db] PostGIS enabled');
  return true;
}
