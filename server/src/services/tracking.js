// Live ETA: combines remaining kitchen prep time with routed travel legs.
import { db } from '../db/index.js';
import { getRoute } from '../geo.js';
import { STATUS, TERMINAL } from '../orderState.js';

const DISPATCH_BUFFER_SEC = 5 * 60; // expected wait to find a driver when none is assigned yet

const legDto = (kind, r) => ({
  kind, coordinates: r.coordinates, distanceKm: Math.round(r.distanceKm * 100) / 100, durationSec: r.durationSec, source: r.source,
});

export async function computeTracking(order) {
  if (TERMINAL.has(order.status) || order.status === STATUS.PENDING_PAYMENT) {
    return { orderId: order.id, etaSeconds: null, etaAt: null, phase: order.status, legs: [] };
  }
  const restaurant = { lat: order.restaurant.lat, lng: order.restaurant.lng };
  const destination = { lat: order.delivery.lat, lng: order.delivery.lng };
  const d = order.driver;
  const driverPos = d?.offerStatus === 'accepted' && d.lat != null ? { lat: d.lat, lng: d.lng } : null;

  let etaSeconds;
  let phase;
  const legs = [];

  if ((order.status === STATUS.PICKED_UP || order.status === STATUS.ON_THE_WAY)) {
    const leg = await getRoute(driverPos ?? restaurant, destination);
    legs.push(legDto('to_customer', leg));
    etaSeconds = leg.durationSec;
    phase = 'delivering';
  } else {
    const accepted = order.events.find((e) => e.status === STATUS.ACCEPTED);
    const prepStart = accepted ? Date.parse(accepted.createdAt) : Date.now();
    const prepRemaining = Math.max(0, (prepStart + order.restaurant.prepTimeMin * 60_000 - Date.now()) / 1000);
    const toCustomer = await getRoute(restaurant, destination);
    let wait = prepRemaining + (driverPos ? 0 : DISPATCH_BUFFER_SEC);
    if (driverPos) {
      const toRestaurant = await getRoute(driverPos, restaurant);
      legs.push(legDto('to_restaurant', toRestaurant));
      wait = Math.max(wait, toRestaurant.durationSec);
    }
    legs.push(legDto('to_customer', toCustomer));
    etaSeconds = wait + toCustomer.durationSec;
    phase = driverPos ? 'driver_to_restaurant' : 'preparing';
  }

  etaSeconds = Math.round(etaSeconds);
  await db.run('UPDATE orders SET eta_seconds = ? WHERE id = ?', [etaSeconds, order.id]);
  return {
    orderId: order.id,
    etaSeconds,
    etaAt: new Date(Date.now() + etaSeconds * 1000).toISOString(),
    phase,
    legs,
  };
}
