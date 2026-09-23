import { db, nowIso } from '../db/index.js';
import { HttpError, assert } from '../errors.js';
import { haversineKm, isValidLatLng } from '../geo.js';
import { emitTo } from '../realtime.js';
import { defineJob, schedule } from '../jobs.js';
import { STATUS, TERMINAL, ACTIVE_DRIVER_STATUSES, DISPATCHABLE, canTransition, allowedNext } from '../orderState.js';
import {
  initiatePayment, checkPayment, cancelPayment, refundPayment, validatePaymentInput, isSandboxRef,
} from './payments.js';

const DISPATCH_OFFER_TIMEOUT_MS = Number(process.env.DISPATCH_OFFER_TIMEOUT_MS) || 45_000;
const DRIVER_SEARCH_RADIUS_KM = 15;
const PAYMENT_POLL_MS = Number(process.env.PAYMENT_POLL_MS) || 3000;
const PAYMENT_TIMEOUT_MS = { card: 15 * 60_000, default: 3 * 60_000 };
const ACTIVE_SQL = ACTIVE_DRIVER_STATUSES.map((s) => `'${s}'`).join(',');

export const parseJson = (v, fallback) => {
  if (typeof v !== 'string') return v ?? fallback;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
};

// ---------- pricing ----------

// selections: { [groupId]: [optionId, ...] }
function priceLine(item, selections, quantity) {
  assert(Number.isInteger(quantity) && quantity >= 1 && quantity <= 50, 400, `Invalid quantity for ${item.name}`);
  let unit = item.price;
  const chosen = [];
  for (const group of parseJson(item.modifiers, [])) {
    const picked = [...new Set(selections?.[group.id] ?? [])];
    const min = group.min ?? 0;
    const max = group.max ?? group.options.length;
    assert(picked.length >= min, 400, `${item.name}: choose at least ${min} for "${group.name}"`);
    assert(picked.length <= max, 400, `${item.name}: choose at most ${max} for "${group.name}"`);
    for (const optionId of picked) {
      const option = group.options.find((o) => o.id === optionId);
      assert(option, 400, `${item.name}: unknown option for "${group.name}"`);
      unit += option.price ?? 0;
      chosen.push({ group: group.name, option: option.name, price: option.price ?? 0 });
    }
  }
  return { unitPrice: unit, modifiers: chosen, lineTotal: unit * quantity };
}

export function deliveryFeeFor(restaurant, distanceKm) {
  // Base fee covers the first 2 km, then 500 UGX per extra km, rounded to 100.
  return restaurant.delivery_fee + Math.round((Math.max(0, distanceKm - 2) * 500) / 100) * 100;
}

export async function quoteOrder({ restaurantId, items, lat, lng }) {
  const restaurant = await db.get('SELECT * FROM restaurants WHERE id = ?', [restaurantId]);
  assert(restaurant, 404, 'Restaurant not found');
  assert(Array.isArray(items) && items.length > 0, 400, 'Your cart is empty');
  assert(items.length <= 50, 400, 'Too many items');
  assert(isValidLatLng(lat, lng), 400, 'Choose a delivery location');

  const distanceKm = haversineKm(restaurant.lat, restaurant.lng, lat, lng);
  const ids = [...new Set(items.map((i) => Number(i?.menuItemId)).filter(Number.isInteger))];
  const rows = ids.length
    ? await db.all(`SELECT * FROM menu_items WHERE restaurant_id = ? AND deleted = 0 AND id IN (${ids.map(() => '?').join(',')})`, [restaurant.id, ...ids])
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));

  const lines = items.map(({ menuItemId, quantity, selections }) => {
    const item = byId.get(Number(menuItemId));
    assert(item, 400, 'An item in your cart is no longer on the menu');
    assert(item.available, 409, `${item.name} is sold out`);
    return { menuItemId: item.id, name: item.name, quantity, ...priceLine(item, selections, quantity) };
  });

  const subtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
  const deliveryFee = deliveryFeeFor(restaurant, distanceKm);
  return {
    restaurant,
    lines,
    subtotal,
    deliveryFee,
    total: subtotal + deliveryFee,
    distanceKm: Math.round(distanceKm * 100) / 100,
    outOfRange: distanceKm > restaurant.delivery_radius_km,
    isOpen: Boolean(restaurant.is_open),
  };
}

// ---------- reads ----------

const ORDER_SELECT = `
  SELECT o.*, r.name AS r_name, r.emoji AS r_emoji, r.address AS r_address, r.lat AS r_lat, r.lng AS r_lng,
         r.prep_time_min AS r_prep, r.owner_id AS r_owner,
         c.name AS c_name, c.phone AS c_phone,
         du.name AS d_name, du.phone AS d_phone, d.vehicle AS d_vehicle, d.lat AS d_lat, d.lng AS d_lng, d.heading AS d_heading
  FROM orders o
  JOIN restaurants r ON r.id = o.restaurant_id
  JOIN users c ON c.id = o.customer_id
  LEFT JOIN users du ON du.id = o.driver_id
  LEFT JOIN drivers d ON d.user_id = o.driver_id`;

// Loads items + events for many orders in two queries.
async function toDtos(rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => '?').join(',');
  const [items, events] = await Promise.all([
    db.all(`SELECT * FROM order_items WHERE order_id IN (${marks}) ORDER BY id`, ids),
    db.all(`SELECT order_id, status, note, created_at FROM order_events WHERE order_id IN (${marks}) ORDER BY id`, ids),
  ]);
  const group = (list) => {
    const m = new Map();
    for (const x of list) m.set(x.order_id, [...(m.get(x.order_id) ?? []), x]);
    return m;
  };
  const itemsBy = group(items);
  const eventsBy = group(events);
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    customerId: row.customer_id,
    customer: { name: row.c_name, phone: row.c_phone },
    restaurant: {
      id: row.restaurant_id, ownerId: row.r_owner, name: row.r_name, emoji: row.r_emoji,
      address: row.r_address, lat: row.r_lat, lng: row.r_lng, prepTimeMin: row.r_prep,
    },
    driver: row.driver_id
      ? {
          id: row.driver_id, name: row.d_name, phone: row.d_phone, vehicle: row.d_vehicle,
          lat: row.d_lat, lng: row.d_lng, heading: row.d_heading,
          offerStatus: row.driver_offer_status, offeredAt: row.driver_offered_at,
        }
      : null,
    delivery: { address: row.delivery_address, lat: row.delivery_lat, lng: row.delivery_lng, notes: row.notes },
    payment: { method: row.payment_method, status: row.payment_status, ref: row.payment_ref, sandbox: isSandboxRef(row.payment_ref) },
    subtotal: row.subtotal,
    deliveryFee: row.delivery_fee,
    total: row.total,
    etaSeconds: row.eta_seconds,
    items: (itemsBy.get(row.id) ?? []).map((i) => ({
      id: i.id, menuItemId: i.menu_item_id, name: i.name, unitPrice: i.unit_price,
      quantity: i.quantity, modifiers: parseJson(i.modifiers, []), lineTotal: i.line_total,
    })),
    events: (eventsBy.get(row.id) ?? []).map((e) => ({ status: e.status, note: e.note, createdAt: e.created_at })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function getOrder(id) {
  if (!Number.isInteger(id)) return null;
  const row = await db.get(`${ORDER_SELECT} WHERE o.id = ?`, [id]);
  return row ? (await toDtos([row]))[0] : null;
}

export function canView(order, user) {
  if (user.role === 'customer') return order.customerId === user.id;
  if (user.role === 'merchant') return order.restaurant.ownerId === user.id;
  if (user.role === 'driver') return order.driver?.id === user.id;
  return false;
}

function allowedNextFor(order, user) {
  if (user.role === 'driver' && order.driver?.offerStatus !== 'accepted') return [];
  return allowedNext(order.status, user.role);
}

export async function getOrderFor(id, user) {
  const order = await getOrder(id);
  assert(order && canView(order, user), 404, 'Order not found');
  return { ...order, allowedNext: allowedNextFor(order, user) };
}

export async function listOrders(user, { restaurantId } = {}) {
  let rows;
  if (user.role === 'customer') {
    rows = await db.all(`${ORDER_SELECT} WHERE o.customer_id = ? ORDER BY o.id DESC LIMIT 50`, [user.id]);
  } else if (user.role === 'merchant') {
    const r = await db.get('SELECT id FROM restaurants WHERE id = ? AND owner_id = ?', [restaurantId, user.id]);
    assert(r, 404, 'Restaurant not found');
    rows = await db.all(`${ORDER_SELECT} WHERE o.restaurant_id = ? ORDER BY o.id DESC LIMIT 100`, [r.id]);
  } else {
    rows = await db.all(`${ORDER_SELECT} WHERE o.driver_id = ? ORDER BY o.id DESC LIMIT 50`, [user.id]);
  }
  return (await toDtos(rows)).map((o) => ({ ...o, allowedNext: allowedNextFor(o, user) }));
}

// ---------- writes ----------

export async function broadcastOrder(orderId, extraRooms = []) {
  const o = await getOrder(orderId);
  if (!o) return;
  emitTo(
    [`user:${o.customerId}`, `restaurant:${o.restaurant.id}`, o.driver && `user:${o.driver.id}`, `order:${o.id}`, ...extraRooms],
    'order:update',
    o,
  );
}

const logEvent = (t, orderId, status, actorId, note = '') =>
  t.run('INSERT INTO order_events (order_id, status, actor_id, note) VALUES (?, ?, ?, ?)', [orderId, status, actorId, note]);

async function setStatus(t, orderId, status, actorId, note) {
  await t.run('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?', [status, nowIso(), orderId]);
  await logEvent(t, orderId, status, actorId, note);
}

export async function createOrder(customer, input) {
  const { restaurantId, items, lat, lng, address, notes = '', paymentMethod, phone } = input;
  const payPhone = validatePaymentInput(paymentMethod, phone);
  assert(typeof address === 'string' && address.trim(), 400, 'Enter a delivery address');

  const quote = await quoteOrder({ restaurantId, items, lat, lng });
  assert(quote.isOpen, 409, `${quote.restaurant.name} is closed right now`);
  assert(!quote.outOfRange, 409,
    `${quote.restaurant.name} only delivers within ${quote.restaurant.delivery_radius_km} km (you are ${quote.distanceKm} km away)`);

  const orderId = await db.tx(async (t) => {
    const { id } = await t.get(`INSERT INTO orders
      (customer_id, restaurant_id, status, payment_method, payment_phone, subtotal, delivery_fee, total,
       delivery_address, delivery_lat, delivery_lng, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`, [
      customer.id, quote.restaurant.id, STATUS.PENDING_PAYMENT, paymentMethod, payPhone,
      quote.subtotal, quote.deliveryFee, quote.total, address.trim().slice(0, 300), lat, lng, String(notes).slice(0, 500),
    ]);
    for (const l of quote.lines) {
      await t.run(`INSERT INTO order_items (order_id, menu_item_id, name, unit_price, quantity, modifiers, line_total)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, l.menuItemId, l.name, l.unitPrice, l.quantity, JSON.stringify(l.modifiers), l.lineTotal]);
    }
    await logEvent(t, id, STATUS.PENDING_PAYMENT, customer.id);
    return id;
  });

  let payment;
  try {
    payment = await initiatePayment({ method: paymentMethod, amount: quote.total, phone: payPhone, orderId });
  } catch (err) {
    console.error(`[payments] ${paymentMethod} start failed for order ${orderId}: ${err.message}`);
    await applyPaymentResult(orderId, 'failed', 'Payment provider unavailable');
    await broadcastOrder(orderId);
    throw new HttpError(502, 'The payment provider is not responding. Please try again or choose another method.');
  }

  await db.run('UPDATE orders SET payment_ref = ? WHERE id = ?', [payment.ref, orderId]);
  if (payment.status === 'pending') {
    const timeout = PAYMENT_TIMEOUT_MS[paymentMethod] ?? PAYMENT_TIMEOUT_MS.default;
    await schedule('payment-poll', { orderId, deadline: Date.now() + timeout }, PAYMENT_POLL_MS);
  } else {
    await applyPaymentResult(orderId, payment.status, payment.message);
  }
  await broadcastOrder(orderId);
  return {
    order: await getOrderFor(orderId, customer),
    paymentMessage: payment.message ?? null,
    clientSecret: payment.clientSecret ?? null,
  };
}

// Asks the provider for the authoritative status and applies it. Used by
// polling jobs, webhooks and the customer's "I've paid" button. Idempotent.
export async function syncPayment({ orderId, ref }) {
  const order = orderId
    ? await db.get('SELECT id, status, payment_method, payment_status, payment_ref, total FROM orders WHERE id = ?', [orderId])
    : await db.get('SELECT id, status, payment_method, payment_status, payment_ref, total FROM orders WHERE payment_ref = ?', [ref]);
  if (!order?.payment_ref || order.payment_method === 'cash') return order ? 'n/a' : 'unknown';

  const needsCheck = order.status === STATUS.PENDING_PAYMENT ||
    (order.status === STATUS.CANCELLED && order.payment_status === 'pending');
  if (!needsCheck) return order.payment_status;

  const result = await checkPayment(order.payment_method, order.payment_ref);
  if (result === 'pending') return 'pending';
  if (order.status === STATUS.PENDING_PAYMENT) {
    await applyPaymentResult(order.id, result, result === 'failed' ? 'Payment was declined' : '');
  } else if (result === 'paid') {
    // Customer cancelled while the payment prompt was open, then approved it: refund.
    await db.run("UPDATE orders SET payment_status = 'refund_pending' WHERE id = ?", [order.id]);
    await settleRefund(order);
  } else {
    await db.run("UPDATE orders SET payment_status = 'failed' WHERE id = ?", [order.id]);
  }
  await broadcastOrder(order.id);
  return result;
}

defineJob('payment-poll', async ({ orderId, deadline }) => {
  const result = await syncPayment({ orderId });
  if (result !== 'pending') return;
  if (Date.now() < deadline) {
    await schedule('payment-poll', { orderId, deadline }, PAYMENT_POLL_MS);
    return;
  }
  const order = await db.get('SELECT payment_method, payment_ref FROM orders WHERE id = ?', [orderId]);
  await cancelPayment(order.payment_method, order.payment_ref).catch(() => {});
  await applyPaymentResult(orderId, 'failed', 'Payment was not completed in time');
  await broadcastOrder(orderId);
});

async function applyPaymentResult(orderId, result, message = '') {
  await db.tx(async (t) => {
    const o = await t.get(`SELECT status FROM orders WHERE id = ? ${db.forUpdate}`, [orderId]);
    if (o.status !== STATUS.PENDING_PAYMENT) return; // already settled or cancelled
    if (result === 'paid' || result === 'cod') {
      await t.run('UPDATE orders SET payment_status = ? WHERE id = ?', [result, orderId]);
      await setStatus(t, orderId, STATUS.PLACED, null, result === 'paid' ? 'Payment received' : 'Cash on delivery');
    } else {
      await t.run("UPDATE orders SET payment_status = 'failed' WHERE id = ?", [orderId]);
      await setStatus(t, orderId, STATUS.CANCELLED, null, message || 'Payment failed');
    }
  });
}

async function settleRefund(order) {
  try {
    const status = await refundPayment(order.payment_method, order.payment_ref, order.total);
    await db.run('UPDATE orders SET payment_status = ? WHERE id = ?', [status, order.id]);
    if (status === 'refund_pending') console.warn(`[payments] order ${order.id}: refund needs manual processing`);
  } catch (err) {
    console.error(`[payments] refund failed for order ${order.id}: ${err.message}`);
  }
}

export async function transitionOrder(orderId, to, user, note = '') {
  const order = await getOrder(orderId);
  assert(order && canView(order, user), 404, 'Order not found');
  assert(canTransition(order.status, to, user.role), 409, `Cannot move order from ${order.status} to ${to}`);
  if (user.role === 'driver') {
    assert(order.driver?.id === user.id && order.driver.offerStatus === 'accepted', 403, 'This delivery is not assigned to you');
  }

  const { refund, releasedDriver } = await db.tx(async (t) => {
    // Re-check under lock so concurrent requests can't double-apply.
    const cur = await t.get(`SELECT status, payment_status, driver_offer_status, driver_id FROM orders WHERE id = ? ${db.forUpdate}`, [orderId]);
    assert(cur.status === order.status, 409, 'Order was updated by someone else, please refresh');
    await setStatus(t, orderId, to, user.id, String(note).slice(0, 300));
    let refund = false;
    let releasedDriver = null;
    if (to === STATUS.CANCELLED || to === STATUS.REJECTED) {
      refund = cur.payment_status === 'paid';
      if (refund) await t.run("UPDATE orders SET payment_status = 'refund_pending' WHERE id = ?", [orderId]);
      if (cur.driver_id && cur.driver_offer_status === 'offered') {
        releasedDriver = cur.driver_id;
        await t.run('UPDATE orders SET driver_id = NULL, driver_offer_status = NULL WHERE id = ?', [orderId]);
      }
    }
    if (to === STATUS.DELIVERED && order.payment.method === 'cash') {
      await t.run("UPDATE orders SET payment_status = 'paid' WHERE id = ?", [orderId]);
    }
    return { refund, releasedDriver };
  });

  if (refund) {
    await settleRefund({ id: orderId, payment_method: order.payment.method, payment_ref: order.payment.ref, total: order.total });
  }
  if (order.status === STATUS.PENDING_PAYMENT && to === STATUS.CANCELLED && order.payment.ref) {
    await cancelPayment(order.payment.method, order.payment.ref).catch(() => {});
  }
  await broadcastOrder(orderId, [releasedDriver && `user:${releasedDriver}`]);
  return getOrderFor(orderId, user);
}

// ---------- dispatch ----------

export async function availableDrivers(lat, lng, radiusKm = DRIVER_SEARCH_RADIUS_KM) {
  const activeJobs = `(SELECT COUNT(*) FROM orders o WHERE o.driver_id = u.id AND o.status IN (${ACTIVE_SQL}))`;
  const rows = db.postgis
    ? await db.all(`
        SELECT u.id, u.name, u.phone, d.vehicle, d.lat, d.lng, d.location_updated_at,
               ST_Distance(d.geog, ST_MakePoint(?::float8, ?::float8)::geography) / 1000 AS distance_km,
               ${activeJobs} AS active_jobs
        FROM drivers d JOIN users u ON u.id = d.user_id
        WHERE d.is_online = 1 AND ST_DWithin(d.geog, ST_MakePoint(?::float8, ?::float8)::geography, ?::float8 * 1000)
        ORDER BY active_jobs, distance_km`, [lng, lat, lng, lat, radiusKm])
    : await db.all(`
        SELECT u.id, u.name, u.phone, d.vehicle, d.lat, d.lng, d.location_updated_at,
               haversine_km(?, ?, d.lat, d.lng) AS distance_km,
               ${activeJobs} AS active_jobs
        FROM drivers d JOIN users u ON u.id = d.user_id
        WHERE d.is_online = 1 AND d.lat IS NOT NULL AND haversine_km(?, ?, d.lat, d.lng) <= ?
        ORDER BY active_jobs, distance_km`, [lat, lng, lat, lng, radiusKm]);
  return rows.map((d) => ({ ...d, distance_km: Math.round(d.distance_km * 100) / 100, busy: d.active_jobs > 0 }));
}

export async function assignDriver(orderId, merchant, driverId) {
  const order = await getOrder(orderId);
  assert(order && canView(order, merchant), 404, 'Order not found');
  assert(DISPATCHABLE.has(order.status), 409, 'Accept the order before assigning a driver');
  assert(order.driver?.offerStatus !== 'accepted', 409, `${order.driver?.name} is already delivering this order`);

  const candidates = (await availableDrivers(order.restaurant.lat, order.restaurant.lng)).filter((d) => !d.busy);
  const driver = driverId ? candidates.find((d) => d.id === Number(driverId)) : candidates[0];
  assert(driver, 409, driverId ? 'That driver is offline or busy' : 'No free drivers online nearby');

  const offeredAt = nowIso();
  const previous = order.driver?.id;
  await db.tx(async (t) => {
    const cur = await t.get(`SELECT status, driver_offer_status FROM orders WHERE id = ? ${db.forUpdate}`, [orderId]);
    assert(DISPATCHABLE.has(cur.status) && cur.driver_offer_status !== 'accepted', 409, 'Order was updated by someone else, please refresh');
    await t.run(`UPDATE orders SET driver_id = ?, driver_offer_status = 'offered', driver_offered_at = ?, updated_at = ? WHERE id = ?`,
      [driver.id, offeredAt, offeredAt, orderId]);
    await logEvent(t, orderId, 'DRIVER_OFFERED', merchant.id, `Offered to ${driver.name}`);
  });
  await schedule('dispatch-expire', { orderId, driverId: driver.id, offeredAt }, DISPATCH_OFFER_TIMEOUT_MS);

  emitTo([`user:${driver.id}`], 'dispatch:offer', {
    order: await getOrder(orderId),
    expiresAt: new Date(Date.parse(offeredAt) + DISPATCH_OFFER_TIMEOUT_MS).toISOString(),
    distanceToRestaurantKm: driver.distance_km,
  });
  await broadcastOrder(orderId, [previous && previous !== driver.id && `user:${previous}`]);
  return getOrderFor(orderId, merchant);
}

// offeredAt pins the job to one specific offer, so a stale timer can't expire a newer one.
defineJob('dispatch-expire', async ({ orderId, driverId, offeredAt }) => {
  const res = await db.run(`UPDATE orders SET driver_id = NULL, driver_offer_status = NULL
    WHERE id = ? AND driver_id = ? AND driver_offer_status = 'offered' AND driver_offered_at = ?`, [orderId, driverId, offeredAt]);
  if (!res.changes) return;
  await db.tx((t) => logEvent(t, orderId, 'DRIVER_OFFER_EXPIRED', null, 'Driver did not respond'));
  await broadcastOrder(orderId, [`user:${driverId}`]);
});

export async function respondToOffer(orderId, driver, accept) {
  await db.tx(async (t) => {
    const cur = await t.get(`SELECT status, driver_id, driver_offer_status FROM orders WHERE id = ? ${db.forUpdate}`, [orderId]);
    assert(cur && cur.driver_id === driver.id && cur.driver_offer_status === 'offered', 409, 'This offer is no longer available');
    assert(!TERMINAL.has(cur.status), 409, 'This order is no longer active');
    if (accept) {
      const { n } = await t.get(`SELECT COUNT(*) AS n FROM orders
        WHERE driver_id = ? AND driver_offer_status = 'accepted' AND status IN (${ACTIVE_SQL})`, [driver.id]);
      assert(!n, 409, 'Finish your current delivery first');
      await t.run("UPDATE orders SET driver_offer_status = 'accepted', updated_at = ? WHERE id = ?", [nowIso(), orderId]);
      await logEvent(t, orderId, 'DRIVER_ASSIGNED', driver.id, `${driver.name} is on the way to the restaurant`);
    } else {
      await t.run('UPDATE orders SET driver_id = NULL, driver_offer_status = NULL, updated_at = ? WHERE id = ?', [nowIso(), orderId]);
      await logEvent(t, orderId, 'DRIVER_DECLINED', driver.id, `${driver.name} declined`);
    }
  });
  await broadcastOrder(orderId, [`user:${driver.id}`]);
  return accept ? getOrderFor(orderId, driver) : null;
}

export async function activeOrdersForDriver(driverId) {
  const rows = await db.all(`SELECT id FROM orders WHERE driver_id = ? AND driver_offer_status = 'accepted' AND status IN (${ACTIVE_SQL})`, [driverId]);
  return rows.map((r) => r.id);
}
