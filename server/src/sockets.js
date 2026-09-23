import { db, nowIso } from './db/index.js';
import { isValidLatLng } from './geo.js';
import { getOrder, canView, activeOrdersForDriver } from './services/orders.js';
import { computeTracking } from './services/tracking.js';

const MIN_LOCATION_INTERVAL_MS = 800;
const ETA_REFRESH_MS = 10_000;
const lastEtaAt = new Map(); // orderId -> timestamp (per instance; fine as a throttle)

export function registerSocketHandlers(io, socket) {
  const { user } = socket.data;
  const safe = (fn) => async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      console.error(`[socket] ${err.message}`);
    }
  };

  socket.on('order:subscribe', safe(async (orderId, ack) => {
    const order = await getOrder(Number(orderId));
    if (!order || !canView(order, user)) return ack?.({ ok: false });
    socket.join(`order:${order.id}`);
    ack?.({ ok: true });
  }));

  socket.on('order:unsubscribe', (orderId) => socket.leave(`order:${Number(orderId)}`));

  if (user.role !== 'driver') return;

  let lastUpdate = 0;
  socket.on('driver:location', safe(async (payload) => {
    const { lat, lng, heading = null, speed = null } = payload ?? {};
    if (!isValidLatLng(lat, lng)) return;
    const now = Date.now();
    if (now - lastUpdate < MIN_LOCATION_INTERVAL_MS) return;
    lastUpdate = now;

    await db.run('UPDATE drivers SET lat = ?, lng = ?, heading = ?, location_updated_at = ? WHERE user_id = ?',
      [lat, lng, Number.isFinite(heading) ? heading : null, nowIso(), user.id]);

    for (const orderId of await activeOrdersForDriver(user.id)) {
      io.to(`order:${orderId}`).emit('order:driver_location', { orderId, lat, lng, heading, speed, at: now });
      if (now - (lastEtaAt.get(orderId) ?? 0) >= ETA_REFRESH_MS) {
        lastEtaAt.set(orderId, now);
        const order = await getOrder(orderId);
        if (order) io.to(`order:${orderId}`).emit('order:eta', await computeTracking(order));
      }
    }
  }));

  // Take the driver off the dispatch pool when their last connection drops,
  // unless they're mid-delivery (a flaky network shouldn't strand an order).
  socket.on('disconnect', safe(async () => {
    const remaining = await io.in(`user:${user.id}`).fetchSockets();
    if (remaining.length === 0 && (await activeOrdersForDriver(user.id)).length === 0) {
      await db.run('UPDATE drivers SET is_online = 0 WHERE user_id = ?', [user.id]);
    }
  }));
}
