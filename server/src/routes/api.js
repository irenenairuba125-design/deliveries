import { Router } from 'express';
import { db, nowIso } from '../db/index.js';
import { assert } from '../errors.js';
import { requireAuth, signToken, verifyPassword, hashPassword } from '../auth.js';
import { rateLimit } from '../rateLimit.js';
import { joinRestaurantRoom } from '../realtime.js';
import { boundingBox, haversineKm, isValidLatLng, getRoute, autocomplete } from '../geo.js';
import {
  quoteOrder, createOrder, getOrderFor, listOrders, transitionOrder,
  assignDriver, respondToOffer, availableDrivers, syncPayment, parseJson,
} from '../services/orders.js';
import { computeTracking } from '../services/tracking.js';
import { paymentConfig, stripeClientSecret } from '../services/payments.js';
import { STATUS } from '../orderState.js';

export const api = Router();

const num = (v) => (v === undefined || v === null || v === '' ? NaN : Number(v));
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, phone: u.phone, role: u.role });
const restaurantDto = (r, from) => ({
  id: r.id, name: r.name, description: r.description, cuisine: r.cuisine, emoji: r.emoji,
  address: r.address, lat: r.lat, lng: r.lng, deliveryRadiusKm: r.delivery_radius_km,
  prepTimeMin: r.prep_time_min, deliveryFee: r.delivery_fee, rating: r.rating, isOpen: Boolean(r.is_open),
  ...(from && { distanceKm: Math.round(haversineKm(from.lat, from.lng, r.lat, r.lng) * 100) / 100 }),
});
const itemDto = (i) => ({
  id: i.id, restaurantId: i.restaurant_id, category: i.category, name: i.name, description: i.description,
  price: i.price, available: Boolean(i.available), modifiers: parseJson(i.modifiers, []), sortOrder: i.sort_order,
});
const RESTAURANT_COLS = `id, owner_id, name, description, cuisine, emoji, address, lat, lng, delivery_radius_km,
  prep_time_min, delivery_fee, rating, is_open`;

// ---------- auth ----------

const loginLimit = rateLimit({
  name: 'login', max: 10, windowMs: 15 * 60_000,
  keyFn: (req) => `${req.ip}:${String(req.body?.email ?? '').toLowerCase()}`,
});
const registerLimit = rateLimit({ name: 'register', max: 5, windowMs: 60 * 60_000 });

api.post('/auth/login', loginLimit, async (req, res) => {
  const { email, password } = req.body ?? {};
  const user = await db.get('SELECT * FROM users WHERE lower(email) = lower(?)', [String(email ?? '').trim()]);
  assert(user && verifyPassword(String(password ?? ''), user.password_hash), 401, 'Wrong email or password');
  res.json({ token: signToken(user), user: publicUser(user) });
});

api.post('/auth/register', registerLimit, async (req, res) => {
  const { email, password, name, phone } = req.body ?? {};
  assert(typeof email === 'string' && /^\S+@\S+\.\S+$/.test(email) && email.length <= 200, 400, 'Enter a valid email');
  assert(typeof password === 'string' && password.length >= 8 && password.length <= 200, 400, 'Password must be at least 8 characters');
  assert(typeof name === 'string' && name.trim() && name.length <= 100, 400, 'Enter your name');
  assert(!(await db.get('SELECT 1 AS x FROM users WHERE lower(email) = lower(?)', [email.trim()])), 409, 'An account with that email already exists');
  const user = await db.get(`INSERT INTO users (email, password_hash, name, phone, role) VALUES (?, ?, ?, ?, 'customer')
    RETURNING id, email, name, phone, role`, [email.trim(), hashPassword(password), name.trim(), phone ? String(phone).slice(0, 30) : null]);
  res.status(201).json({ token: signToken(user), user: publicUser(user) });
});

api.get('/auth/me', requireAuth(), async (req, res) => {
  const user = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  assert(user, 401, 'Please sign in');
  res.json({ user: publicUser(user) });
});

// ---------- discovery (public) ----------

// Restaurants whose own delivery radius covers (lat, lng).
async function restaurantsDeliveringTo(lat, lng) {
  const MAX_RADIUS_KM = 25;
  if (db.postgis) {
    return db.all(`
      SELECT ${RESTAURANT_COLS}, ST_Distance(geog, ST_MakePoint(?::float8, ?::float8)::geography) / 1000 AS distance_km
      FROM restaurants
      WHERE ST_DWithin(geog, ST_MakePoint(?::float8, ?::float8)::geography, ${MAX_RADIUS_KM * 1000})
        AND ST_DWithin(geog, ST_MakePoint(?::float8, ?::float8)::geography, delivery_radius_km * 1000)
      ORDER BY is_open DESC, distance_km`, [lng, lat, lng, lat, lng, lat]);
  }
  // Bounding-box prefilter (uses the lat/lng index), then the exact distance check.
  const b = boundingBox(lat, lng, MAX_RADIUS_KM);
  return db.all(`
    SELECT ${RESTAURANT_COLS}, haversine_km(?, ?, lat, lng) AS distance_km FROM restaurants
    WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
      AND haversine_km(?, ?, lat, lng) <= delivery_radius_km
    ORDER BY is_open DESC, distance_km`, [lat, lng, b.minLat, b.maxLat, b.minLng, b.maxLng, lat, lng]);
}

api.get('/restaurants', async (req, res) => {
  const lat = num(req.query.lat);
  const lng = num(req.query.lng);
  if (!isValidLatLng(lat, lng)) {
    const rows = await db.all(`SELECT ${RESTAURANT_COLS} FROM restaurants ORDER BY name`);
    return res.json({ restaurants: rows.map((r) => restaurantDto(r)) });
  }
  res.json({ restaurants: (await restaurantsDeliveringTo(lat, lng)).map((r) => restaurantDto(r, { lat, lng })) });
});

api.get('/restaurants/:id', async (req, res) => {
  const r = await db.get(`SELECT ${RESTAURANT_COLS} FROM restaurants WHERE id = ?`, [num(req.params.id)]);
  assert(r, 404, 'Restaurant not found');
  const lat = num(req.query.lat);
  const lng = num(req.query.lng);
  const items = await db.all('SELECT * FROM menu_items WHERE restaurant_id = ? AND deleted = 0 ORDER BY category, sort_order, id', [r.id]);
  res.json({ restaurant: restaurantDto(r, isValidLatLng(lat, lng) ? { lat, lng } : null), menu: items.map(itemDto) });
});

api.get('/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim().toLowerCase().slice(0, 100);
  const lat = num(req.query.lat);
  const lng = num(req.query.lng);
  const hasLoc = isValidLatLng(lat, lng);
  const from = hasLoc ? { lat, lng } : null;
  const pool = hasLoc ? await restaurantsDeliveringTo(lat, lng) : await db.all(`SELECT ${RESTAURANT_COLS} FROM restaurants`);
  if (!q) return res.json({ results: pool.map((r) => ({ restaurant: restaurantDto(r, from), items: [] })) });

  const like = `%${q.replace(/[%_]/g, '')}%`;
  const ids = pool.map((r) => r.id);
  const hits = ids.length
    ? await db.all(`SELECT * FROM menu_items WHERE deleted = 0 AND restaurant_id IN (${ids.map(() => '?').join(',')})
        AND (lower(name) LIKE ? OR lower(description) LIKE ? OR lower(category) LIKE ?)
        ORDER BY available DESC, id`, [...ids, like, like, like])
    : [];
  const results = pool
    .map((r) => {
      const nameHit = r.name.toLowerCase().includes(q) || r.cuisine.toLowerCase().includes(q);
      const items = hits.filter((i) => i.restaurant_id === r.id).slice(0, 5).map(itemDto);
      return nameHit || items.length ? { restaurant: restaurantDto(r, from), items, nameHit } : null;
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.nameHit) - Number(a.nameHit));
  res.json({ results });
});

// ---------- geo ----------

api.get('/geo/autocomplete', rateLimit({ name: 'geocode', max: 60, windowMs: 60_000 }), async (req, res) => {
  res.json({ results: await autocomplete(String(req.query.q ?? '').slice(0, 200)) });
});

api.get('/geo/route', rateLimit({ name: 'route', max: 120, windowMs: 60_000 }), async (req, res) => {
  const [fLat, fLng, tLat, tLng] = ['fromLat', 'fromLng', 'toLat', 'toLng'].map((k) => num(req.query[k]));
  assert(isValidLatLng(fLat, fLng) && isValidLatLng(tLat, tLng), 400, 'Invalid coordinates');
  res.json({ route: await getRoute({ lat: fLat, lng: fLng }, { lat: tLat, lng: tLng }) });
});

// ---------- orders ----------

api.get('/payment-methods', (_req, res) => res.json(paymentConfig()));

api.post('/orders/quote', requireAuth('customer'), async (req, res) => {
  const { restaurant, ...quote } = await quoteOrder(req.body ?? {});
  res.json({ ...quote, restaurant: restaurantDto(restaurant), deliveryRadiusKm: restaurant.delivery_radius_km });
});

api.post('/orders', requireAuth('customer'), rateLimit({ name: 'order', max: 20, windowMs: 10 * 60_000, keyFn: (req) => req.user.id }),
  async (req, res) => {
    res.status(201).json(await createOrder(req.user, req.body ?? {}));
  });

api.get('/orders', requireAuth(), async (req, res) => {
  res.json({ orders: await listOrders(req.user, { restaurantId: num(req.query.restaurantId) }) });
});

api.get('/orders/:id', requireAuth(), async (req, res) => {
  res.json({ order: await getOrderFor(num(req.params.id), req.user) });
});

api.get('/orders/:id/tracking', requireAuth(), async (req, res) => {
  res.json({ tracking: await computeTracking(await getOrderFor(num(req.params.id), req.user)) });
});

api.post('/orders/:id/status', requireAuth(), async (req, res) => {
  const { status, note } = req.body ?? {};
  assert(Object.values(STATUS).includes(status), 400, 'Unknown status');
  res.json({ order: await transitionOrder(num(req.params.id), status, req.user, note) });
});

api.post('/orders/:id/assign', requireAuth('merchant'), async (req, res) => {
  res.json({ order: await assignDriver(num(req.params.id), req.user, req.body?.driverId) });
});

api.post('/orders/:id/offer-response', requireAuth('driver'), async (req, res) => {
  res.json({ order: await respondToOffer(num(req.params.id), req.user, Boolean(req.body?.accept)) });
});

// Card payments: the client needs the PaymentIntent's client secret to show Stripe's form.
api.get('/orders/:id/payment', requireAuth('customer'), async (req, res) => {
  const order = await getOrderFor(num(req.params.id), req.user);
  const payable = order.status === STATUS.PENDING_PAYMENT && order.payment.method === 'card' && !order.payment.sandbox;
  res.json({
    clientSecret: payable ? await stripeClientSecret(order.payment.ref) : null,
    stripePublishableKey: paymentConfig().stripePublishableKey,
  });
});

// "I've paid" — re-checks with the provider (also covers setups without webhooks).
api.post('/orders/:id/payment/check', requireAuth('customer'), rateLimit({ name: 'paycheck', max: 30, windowMs: 60_000, keyFn: (req) => req.user.id }),
  async (req, res) => {
    const order = await getOrderFor(num(req.params.id), req.user);
    await syncPayment({ orderId: order.id });
    res.json({ order: await getOrderFor(order.id, req.user) });
  });

// ---------- merchant ----------

async function ownedRestaurant(req) {
  const r = await db.get(`SELECT ${RESTAURANT_COLS} FROM restaurants WHERE id = ? AND owner_id = ?`, [num(req.params.rid), req.user.id]);
  assert(r, 404, 'Restaurant not found');
  return r;
}

function validateItem(body, partial = false) {
  const out = {};
  if (!partial || body.name !== undefined) {
    assert(typeof body.name === 'string' && body.name.trim(), 400, 'Item name is required');
    out.name = body.name.trim().slice(0, 100);
  }
  if (!partial || body.price !== undefined) {
    assert(Number.isInteger(body.price) && body.price >= 0 && body.price <= 100_000_000, 400, 'Price must be a whole number of UGX');
    out.price = body.price;
  }
  if (body.category !== undefined) out.category = String(body.category).trim().slice(0, 50) || 'Mains';
  if (body.description !== undefined) out.description = String(body.description).slice(0, 500);
  if (body.available !== undefined) out.available = body.available ? 1 : 0;
  if (body.modifiers !== undefined) {
    assert(Array.isArray(body.modifiers) && body.modifiers.length <= 20, 400, 'Invalid modifiers');
    out.modifiers = JSON.stringify(body.modifiers.map((g, gi) => {
      assert(g && typeof g.name === 'string' && g.name.trim(), 400, 'Every modifier group needs a name');
      assert(Array.isArray(g.options) && g.options.length && g.options.length <= 50, 400, `"${g.name}" needs at least one option`);
      const min = Math.max(0, Number.parseInt(g.min ?? 0, 10) || 0);
      const max = Math.max(min, Number.parseInt(g.max ?? g.options.length, 10) || g.options.length);
      assert(min <= g.options.length, 400, `"${g.name}": minimum is larger than the number of options`);
      return {
        id: String(g.id || `g${gi}`).slice(0, 40), name: g.name.trim().slice(0, 60), min, max: Math.min(max, g.options.length),
        options: g.options.map((o, oi) => {
          assert(o && typeof o.name === 'string' && o.name.trim(), 400, `Every option in "${g.name}" needs a name`);
          const price = Number(o.price ?? 0);
          assert(Number.isInteger(price) && price >= 0, 400, 'Option prices must be whole UGX amounts');
          return { id: String(o.id || `o${oi}`).slice(0, 40), name: o.name.trim().slice(0, 60), price };
        }),
      };
    }));
  }
  return out;
}

api.get('/merchant/restaurants', requireAuth('merchant'), async (req, res) => {
  const rows = await db.all(`SELECT ${RESTAURANT_COLS} FROM restaurants WHERE owner_id = ? ORDER BY id`, [req.user.id]);
  rows.forEach((r) => joinRestaurantRoom(req.user.id, r.id));
  res.json({ restaurants: rows.map((r) => restaurantDto(r)) });
});

api.patch('/merchant/restaurants/:rid', requireAuth('merchant'), async (req, res) => {
  const r = await ownedRestaurant(req);
  const { isOpen, prepTimeMin } = req.body ?? {};
  if (isOpen !== undefined) await db.run('UPDATE restaurants SET is_open = ? WHERE id = ?', [isOpen ? 1 : 0, r.id]);
  if (prepTimeMin !== undefined) {
    assert(Number.isInteger(prepTimeMin) && prepTimeMin > 0 && prepTimeMin < 180, 400, 'Invalid prep time');
    await db.run('UPDATE restaurants SET prep_time_min = ? WHERE id = ?', [prepTimeMin, r.id]);
  }
  res.json({ restaurant: restaurantDto(await db.get(`SELECT ${RESTAURANT_COLS} FROM restaurants WHERE id = ?`, [r.id])) });
});

api.get('/merchant/restaurants/:rid/drivers', requireAuth('merchant'), async (req, res) => {
  const r = await ownedRestaurant(req);
  res.json({ drivers: await availableDrivers(r.lat, r.lng) });
});

api.post('/merchant/restaurants/:rid/menu', requireAuth('merchant'), async (req, res) => {
  const r = await ownedRestaurant(req);
  const v = validateItem(req.body ?? {});
  const item = await db.get(`INSERT INTO menu_items (restaurant_id, category, name, description, price, available, modifiers)
    VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  [r.id, v.category ?? 'Mains', v.name, v.description ?? '', v.price, v.available ?? 1, v.modifiers ?? '[]']);
  res.status(201).json({ item: itemDto(item) });
});

api.patch('/merchant/restaurants/:rid/menu/:itemId', requireAuth('merchant'), async (req, res) => {
  const r = await ownedRestaurant(req);
  const item = await db.get('SELECT id FROM menu_items WHERE id = ? AND restaurant_id = ? AND deleted = 0', [num(req.params.itemId), r.id]);
  assert(item, 404, 'Menu item not found');
  const v = validateItem(req.body ?? {}, true);
  const cols = Object.keys(v); // whitelisted by validateItem
  if (cols.length) {
    await db.run(`UPDATE menu_items SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => v[c]), item.id]);
  }
  res.json({ item: itemDto(await db.get('SELECT * FROM menu_items WHERE id = ?', [item.id])) });
});

// Soft delete: past orders still reference the item.
api.delete('/merchant/restaurants/:rid/menu/:itemId', requireAuth('merchant'), async (req, res) => {
  const r = await ownedRestaurant(req);
  const result = await db.run('UPDATE menu_items SET deleted = 1 WHERE id = ? AND restaurant_id = ? AND deleted = 0', [num(req.params.itemId), r.id]);
  assert(result.changes, 404, 'Menu item not found');
  res.status(204).end();
});

// ---------- driver ----------

api.get('/driver/me', requireAuth('driver'), async (req, res) => {
  const d = await db.get('SELECT vehicle, is_online, lat, lng FROM drivers WHERE user_id = ?', [req.user.id]);
  assert(d, 404, 'Driver profile not found');
  res.json({ driver: { vehicle: d.vehicle, isOnline: Boolean(d.is_online), lat: d.lat, lng: d.lng } });
});

api.post('/driver/status', requireAuth('driver'), async (req, res) => {
  const { online, lat, lng } = req.body ?? {};
  if (online) assert(isValidLatLng(lat, lng), 400, 'Share your location to go online');
  await db.run(`UPDATE drivers SET is_online = ?, lat = COALESCE(?, lat), lng = COALESCE(?, lng),
    location_updated_at = ? WHERE user_id = ?`,
  [online ? 1 : 0, online ? lat : null, online ? lng : null, nowIso(), req.user.id]);
  res.json({ ok: true });
});
