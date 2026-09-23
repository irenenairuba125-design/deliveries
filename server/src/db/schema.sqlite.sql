CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  phone         TEXT,
  role          TEXT NOT NULL CHECK (role IN ('customer','merchant','driver')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users (lower(email));

CREATE TABLE IF NOT EXISTS restaurants (
  id                 INTEGER PRIMARY KEY,
  owner_id           INTEGER NOT NULL REFERENCES users(id),
  name               TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  cuisine            TEXT NOT NULL DEFAULT '',
  emoji              TEXT NOT NULL DEFAULT '🍽️',
  address            TEXT NOT NULL,
  lat                REAL NOT NULL,
  lng                REAL NOT NULL,
  delivery_radius_km REAL NOT NULL DEFAULT 5,
  prep_time_min      INTEGER NOT NULL DEFAULT 15,
  delivery_fee       INTEGER NOT NULL DEFAULT 3000,
  rating             REAL NOT NULL DEFAULT 4.5,
  is_open            INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS restaurants_latlng ON restaurants (lat, lng);

CREATE TABLE IF NOT EXISTS menu_items (
  id            INTEGER PRIMARY KEY,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  category      TEXT NOT NULL DEFAULT 'Mains',
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  price         INTEGER NOT NULL CHECK (price >= 0),
  available     INTEGER NOT NULL DEFAULT 1,
  modifiers     TEXT NOT NULL DEFAULT '[]',
  sort_order    INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS menu_items_restaurant ON menu_items (restaurant_id);

CREATE TABLE IF NOT EXISTS drivers (
  user_id             INTEGER PRIMARY KEY REFERENCES users(id),
  vehicle             TEXT NOT NULL DEFAULT 'Motorbike',
  is_online           INTEGER NOT NULL DEFAULT 0,
  lat                 REAL,
  lng                 REAL,
  heading             REAL,
  location_updated_at TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id                  INTEGER PRIMARY KEY,
  customer_id         INTEGER NOT NULL REFERENCES users(id),
  restaurant_id       INTEGER NOT NULL REFERENCES restaurants(id),
  driver_id           INTEGER REFERENCES users(id),
  driver_offer_status TEXT CHECK (driver_offer_status IN ('offered','accepted')),
  driver_offered_at   TEXT,
  status              TEXT NOT NULL,
  payment_method      TEXT NOT NULL,
  payment_status      TEXT NOT NULL DEFAULT 'pending',
  payment_ref         TEXT,
  payment_phone       TEXT,
  subtotal            INTEGER NOT NULL,
  delivery_fee        INTEGER NOT NULL,
  total               INTEGER NOT NULL,
  delivery_address    TEXT NOT NULL,
  delivery_lat        REAL NOT NULL,
  delivery_lng        REAL NOT NULL,
  notes               TEXT NOT NULL DEFAULT '',
  eta_seconds         INTEGER,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS orders_customer ON orders (customer_id);
CREATE INDEX IF NOT EXISTS orders_restaurant_status ON orders (restaurant_id, status);
CREATE INDEX IF NOT EXISTS orders_driver_status ON orders (driver_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS orders_payment_ref ON orders (payment_ref);

CREATE TABLE IF NOT EXISTS order_items (
  id           INTEGER PRIMARY KEY,
  order_id     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id INTEGER NOT NULL REFERENCES menu_items(id),
  name         TEXT NOT NULL,
  unit_price   INTEGER NOT NULL,
  quantity     INTEGER NOT NULL,
  modifiers    TEXT NOT NULL DEFAULT '[]',
  line_total   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS order_items_order ON order_items (order_id);

CREATE TABLE IF NOT EXISTS order_events (
  id         INTEGER PRIMARY KEY,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status     TEXT NOT NULL,
  actor_id   INTEGER,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS order_events_order ON order_events (order_id);
