-- PostgreSQL schema. Column types are chosen so the same SQL runs on SQLite in
-- development: flags are SMALLINT 0/1, coordinates are DOUBLE PRECISION.
-- If the PostGIS extension is available, db/postgres.js additionally adds
-- geography columns + GiST indexes and radius queries switch to ST_DWithin.

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  phone         TEXT,
  role          TEXT NOT NULL CHECK (role IN ('customer','merchant','driver')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users (lower(email));

CREATE TABLE IF NOT EXISTS restaurants (
  id                 BIGSERIAL PRIMARY KEY,
  owner_id           BIGINT NOT NULL REFERENCES users(id),
  name               TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  cuisine            TEXT NOT NULL DEFAULT '',
  emoji              TEXT NOT NULL DEFAULT '🍽️',
  address            TEXT NOT NULL,
  lat                DOUBLE PRECISION NOT NULL,
  lng                DOUBLE PRECISION NOT NULL,
  delivery_radius_km DOUBLE PRECISION NOT NULL DEFAULT 5,
  prep_time_min      INTEGER NOT NULL DEFAULT 15,
  delivery_fee       INTEGER NOT NULL DEFAULT 3000,
  rating             DOUBLE PRECISION NOT NULL DEFAULT 4.5,
  is_open            SMALLINT NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS restaurants_latlng ON restaurants (lat, lng);

CREATE TABLE IF NOT EXISTS menu_items (
  id            BIGSERIAL PRIMARY KEY,
  restaurant_id BIGINT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  category      TEXT NOT NULL DEFAULT 'Mains',
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  price         INTEGER NOT NULL CHECK (price >= 0),
  available     SMALLINT NOT NULL DEFAULT 1,
  modifiers     TEXT NOT NULL DEFAULT '[]',
  sort_order    INTEGER NOT NULL DEFAULT 0,
  deleted       SMALLINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS menu_items_restaurant ON menu_items (restaurant_id);

CREATE TABLE IF NOT EXISTS drivers (
  user_id             BIGINT PRIMARY KEY REFERENCES users(id),
  vehicle             TEXT NOT NULL DEFAULT 'Motorbike',
  is_online           SMALLINT NOT NULL DEFAULT 0,
  lat                 DOUBLE PRECISION,
  lng                 DOUBLE PRECISION,
  heading             DOUBLE PRECISION,
  location_updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS orders (
  id                  BIGSERIAL PRIMARY KEY,
  customer_id         BIGINT NOT NULL REFERENCES users(id),
  restaurant_id       BIGINT NOT NULL REFERENCES restaurants(id),
  driver_id           BIGINT REFERENCES users(id),
  driver_offer_status TEXT CHECK (driver_offer_status IN ('offered','accepted')),
  driver_offered_at   TIMESTAMPTZ,
  status              TEXT NOT NULL,
  payment_method      TEXT NOT NULL,
  payment_status      TEXT NOT NULL DEFAULT 'pending',
  payment_ref         TEXT,
  payment_phone       TEXT,
  subtotal            INTEGER NOT NULL,
  delivery_fee        INTEGER NOT NULL,
  total               INTEGER NOT NULL,
  delivery_address    TEXT NOT NULL,
  delivery_lat        DOUBLE PRECISION NOT NULL,
  delivery_lng        DOUBLE PRECISION NOT NULL,
  notes               TEXT NOT NULL DEFAULT '',
  eta_seconds         INTEGER,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_customer ON orders (customer_id);
CREATE INDEX IF NOT EXISTS orders_restaurant_status ON orders (restaurant_id, status);
CREATE INDEX IF NOT EXISTS orders_driver_status ON orders (driver_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS orders_payment_ref ON orders (payment_ref);

CREATE TABLE IF NOT EXISTS order_items (
  id           BIGSERIAL PRIMARY KEY,
  order_id     BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id BIGINT NOT NULL REFERENCES menu_items(id),
  name         TEXT NOT NULL,
  unit_price   INTEGER NOT NULL,
  quantity     INTEGER NOT NULL,
  modifiers    TEXT NOT NULL DEFAULT '[]',
  line_total   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS order_items_order ON order_items (order_id);

CREATE TABLE IF NOT EXISTS order_events (
  id         BIGSERIAL PRIMARY KEY,
  order_id   BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status     TEXT NOT NULL,
  actor_id   BIGINT,
  note       TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_events_order ON order_events (order_id);

-- Great-circle distance in km; same signature as the function the SQLite adapter registers.
CREATE OR REPLACE FUNCTION haversine_km(lat1 float8, lng1 float8, lat2 float8, lng2 float8)
RETURNS float8 LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT 2 * 6371 * asin(least(1, sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)
  )))
$$;
