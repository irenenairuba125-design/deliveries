import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, waitFor, nextEvent, sleep, HOME } from './helpers.js';

let srv;
let tokens;
let menu;

before(async () => {
  srv = await startServer({ DISPATCH_OFFER_TIMEOUT_MS: '1500' });
  const emails = ['customer@demo.test', 'merchant@demo.test', 'merchant2@demo.test', 'driver@demo.test', 'driver2@demo.test'];
  const [customer, merchant, merchant2, driver, driver2] = await Promise.all(emails.map((e) => srv.login(e)));
  tokens = { customer, merchant, merchant2, driver, driver2 };
  menu = (await srv.ok(null, 'GET', '/api/restaurants/1')).menu;
});
after(() => srv?.stop());

const rolex = () => menu.find((m) => m.name === 'Rolex');
const rolexLine = (quantity = 2) => ({ menuItemId: rolex().id, quantity, selections: { extras: ['egg', 'avo'], spice: ['hot'] } });
const order = (extra = {}) => ({ restaurantId: 1, items: [rolexLine()], ...HOME, address: 'Kampala Road', paymentMethod: 'cash', ...extra });

async function placedOrder(extra) {
  const { order: o } = await srv.ok(tokens.customer, 'POST', '/api/orders', order(extra));
  return o;
}

test('discovery: radius filter and search', async () => {
  const { restaurants } = await srv.ok(null, 'GET', `/api/restaurants?lat=${HOME.lat}&lng=${HOME.lng}`);
  assert.equal(restaurants.length, 4, 'Green Bowl (5 km radius, ~4.7 km+ away) should be excluded from central Kampala');
  assert.ok(restaurants.every((r) => r.distanceKm <= r.deliveryRadiusKm));
  const far = await srv.ok(null, 'GET', '/api/restaurants?lat=-1.28&lng=36.82'); // Nairobi
  assert.equal(far.restaurants.length, 0);
  const { results } = await srv.ok(null, 'GET', `/api/search?q=curry&lat=${HOME.lat}&lng=${HOME.lng}`);
  assert.deepEqual(results.map((r) => r.restaurant.name), ['Spice Route']);
  const dish = await srv.ok(null, 'GET', `/api/search?q=naan&lat=${HOME.lat}&lng=${HOME.lng}`);
  assert.equal(dish.results[0].items[0].name, 'Garlic naan');
});

test('auth: login, register, bad password, role guard', async () => {
  assert.equal((await srv.call(null, 'POST', '/api/auth/login', { email: 'customer@demo.test', password: 'nope' })).status, 401);
  const reg = await srv.call(null, 'POST', '/api/auth/register', { email: 'New@Example.com', password: 'longenough1', name: 'New User' });
  assert.equal(reg.status, 201);
  assert.equal((await srv.call(null, 'POST', '/api/auth/register', { email: 'new@example.com', password: 'longenough1', name: 'Dup' })).status, 409);
  assert.equal((await srv.call(null, 'POST', '/api/auth/login', { email: 'NEW@example.com', password: 'longenough1' })).status, 200);
  assert.equal((await srv.call(tokens.customer, 'GET', '/api/merchant/restaurants')).status, 403);
  assert.equal((await srv.call('forged.token', 'GET', '/api/auth/me')).status, 401);
});

test('pricing is computed server-side and modifiers are validated', async () => {
  const q = await srv.ok(tokens.customer, 'POST', '/api/orders/quote', { restaurantId: 1, items: [rolexLine()], ...HOME });
  assert.equal(q.subtotal, 2 * (5000 + 1000 + 1500));
  assert.equal(q.total, q.subtotal + q.deliveryFee);
  const missing = await srv.call(tokens.customer, 'POST', '/api/orders/quote', {
    restaurantId: 1, items: [{ menuItemId: rolex().id, quantity: 1, selections: {} }], ...HOME,
  });
  assert.equal(missing.status, 400);
  assert.match(missing.data.error, /Spice level/);
  const foreign = await srv.call(tokens.customer, 'POST', '/api/orders', order({ restaurantId: 3 }));
  assert.equal(foreign.status, 400, 'items from another restaurant are rejected');
  const far = await srv.call(tokens.customer, 'POST', '/api/orders', order({ lat: 0.2, lng: 32.4 }));
  assert.equal(far.status, 409);
  const wrongNetwork = await srv.call(tokens.customer, 'POST', '/api/orders', order({ paymentMethod: 'mtn_momo', phone: '0701234567' }));
  assert.equal(wrongNetwork.status, 400);
});

test('full lifecycle with dispatch, live location and ETA', async () => {
  const cs = await srv.socket(tokens.customer);
  const ds = await srv.socket(tokens.driver);
  const ms2 = await srv.socket(tokens.merchant2);
  const leaked = [];
  ms2.on('order:update', (o) => leaked.push(o.id));

  const { order: created, paymentMessage } = await srv.ok(tokens.customer, 'POST', '/api/orders',
    order({ paymentMethod: 'mtn_momo', phone: '+256 772 123 456' }));
  assert.equal(created.status, 'PENDING_PAYMENT');
  assert.match(paymentMessage, /0772123456/);
  const id = created.id;
  assert.deepEqual(await cs.emitWithAck('order:subscribe', id), { ok: true });
  assert.deepEqual(await ds.emitWithAck('order:subscribe', id), { ok: false }, 'unassigned driver cannot watch the order');

  await waitFor(async () => (await srv.ok(tokens.customer, 'GET', `/api/orders/${id}`)).order.status === 'PLACED', { label: 'payment settles' });

  assert.equal((await srv.call(tokens.merchant2, 'POST', `/api/orders/${id}/status`, { status: 'ACCEPTED' })).status, 404);
  assert.equal((await srv.call(tokens.customer, 'POST', `/api/orders/${id}/status`, { status: 'ACCEPTED' })).status, 409);
  assert.equal((await srv.call(tokens.merchant, 'POST', `/api/orders/${id}/assign`, {})).status, 409, 'must accept first');
  await srv.ok(tokens.merchant, 'POST', `/api/orders/${id}/status`, { status: 'ACCEPTED' });
  assert.equal((await srv.call(tokens.merchant, 'POST', `/api/orders/${id}/assign`, {})).status, 409, 'no drivers online');

  await srv.ok(tokens.driver, 'POST', '/api/driver/status', { online: true, lat: 0.319, lng: 32.585 });
  const { drivers } = await srv.ok(tokens.merchant, 'GET', '/api/merchant/restaurants/1/drivers');
  assert.equal(drivers.length, 1);
  const offer = nextEvent(ds, 'dispatch:offer');
  await srv.ok(tokens.merchant, 'POST', `/api/orders/${id}/assign`, {});
  assert.equal((await offer).order.id, id);
  assert.equal((await srv.call(tokens.driver, 'POST', `/api/orders/${id}/status`, { status: 'PICKED_UP' })).status, 409);

  await srv.ok(tokens.driver, 'POST', `/api/orders/${id}/offer-response`, { accept: true });
  await srv.ok(tokens.merchant, 'POST', `/api/orders/${id}/status`, { status: 'IN_KITCHEN' });
  const { tracking } = await srv.ok(tokens.customer, 'GET', `/api/orders/${id}/tracking`);
  assert.equal(tracking.phase, 'driver_to_restaurant');
  assert.deepEqual(tracking.legs.map((l) => l.kind), ['to_restaurant', 'to_customer']);
  assert.ok(tracking.etaSeconds > 0);

  const loc = nextEvent(cs, 'order:driver_location', (p) => p.orderId === id);
  const eta = nextEvent(cs, 'order:eta', (p) => p.orderId === id);
  ds.emit('driver:location', { lat: 0.325, lng: 32.59, heading: 45 });
  assert.equal((await loc).lat, 0.325);
  assert.ok((await eta).etaSeconds > 0);

  for (const s of ['PICKED_UP', 'ON_THE_WAY', 'DELIVERED']) await srv.ok(tokens.driver, 'POST', `/api/orders/${id}/status`, { status: s });
  const final = (await srv.ok(tokens.customer, 'GET', `/api/orders/${id}`)).order;
  assert.equal(final.status, 'DELIVERED');
  assert.equal(final.payment.status, 'paid');
  assert.deepEqual(final.events.map((e) => e.status), [
    'PENDING_PAYMENT', 'PLACED', 'ACCEPTED', 'DRIVER_OFFERED', 'DRIVER_ASSIGNED', 'IN_KITCHEN', 'PICKED_UP', 'ON_THE_WAY', 'DELIVERED',
  ]);
  await sleep(200);
  assert.deepEqual(leaked, [], 'another restaurant received no updates');
});

test('dispatch offers expire and can be declined', async () => {
  await srv.ok(tokens.driver2, 'POST', '/api/driver/status', { online: true, lat: 0.32, lng: 32.59 });
  const o = await placedOrder();
  await srv.ok(tokens.merchant, 'POST', `/api/orders/${o.id}/status`, { status: 'ACCEPTED' });
  await srv.ok(tokens.merchant, 'POST', `/api/orders/${o.id}/assign`, { driverId: 5 });
  await waitFor(async () => (await srv.ok(tokens.merchant, 'GET', `/api/orders/${o.id}`)).order.driver === null, { label: 'offer expiry' });
  const events = (await srv.ok(tokens.merchant, 'GET', `/api/orders/${o.id}`)).order.events.map((e) => e.status);
  assert.ok(events.includes('DRIVER_OFFER_EXPIRED'));

  await srv.ok(tokens.merchant, 'POST', `/api/orders/${o.id}/assign`, { driverId: 5 });
  assert.equal(await srv.ok(tokens.driver2, 'POST', `/api/orders/${o.id}/offer-response`, { accept: false }).then((r) => r.order), null);
  assert.equal((await srv.call(tokens.driver2, 'POST', `/api/orders/${o.id}/offer-response`, { accept: true })).status, 409);
});

test('sandbox payment decline cancels the order; rejection refunds a paid order', async () => {
  const { order: declined } = await srv.ok(tokens.customer, 'POST', '/api/orders', order({ paymentMethod: 'airtel_money', phone: '0701234000' }));
  const settled = await waitFor(async () => {
    const o = (await srv.ok(tokens.customer, 'GET', `/api/orders/${declined.id}`)).order;
    return o.status !== 'PENDING_PAYMENT' && o;
  }, { label: 'decline' });
  assert.equal(settled.status, 'CANCELLED');
  assert.equal(settled.payment.status, 'failed');

  const card = await placedOrder({ paymentMethod: 'card' });
  assert.equal(card.status, 'PLACED');
  const rejected = await srv.ok(tokens.merchant, 'POST', `/api/orders/${card.id}/status`, { status: 'REJECTED', note: 'Out of chapati' });
  assert.equal(rejected.order.status, 'REJECTED');
  assert.equal(rejected.order.payment.status, 'refunded');
});

test('customer can cancel only before acceptance', async () => {
  const o = await placedOrder();
  await srv.ok(tokens.customer, 'POST', `/api/orders/${o.id}/status`, { status: 'CANCELLED' });
  const o2 = await placedOrder();
  await srv.ok(tokens.merchant, 'POST', `/api/orders/${o2.id}/status`, { status: 'ACCEPTED' });
  assert.equal((await srv.call(tokens.customer, 'POST', `/api/orders/${o2.id}/status`, { status: 'CANCELLED' })).status, 409);
});

test('concurrent transitions apply once', async () => {
  const o = await placedOrder();
  const results = await Promise.all([1, 2, 3].map(() => srv.call(tokens.merchant, 'POST', `/api/orders/${o.id}/status`, { status: 'ACCEPTED' })));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  const events = (await srv.ok(tokens.merchant, 'GET', `/api/orders/${o.id}`)).order.events.filter((e) => e.status === 'ACCEPTED');
  assert.equal(events.length, 1);
});

test('menu management and sold-out items', async () => {
  const { item } = await srv.ok(tokens.merchant, 'POST', '/api/merchant/restaurants/1/menu', {
    name: 'Test wrap', price: 1000, modifiers: [{ name: 'Size', min: 1, max: 1, options: [{ name: 'S', price: 0 }, { name: 'L', price: 500 }] }],
  });
  assert.equal(item.modifiers[0].options[1].price, 500);
  await srv.ok(tokens.merchant, 'PATCH', `/api/merchant/restaurants/1/menu/${item.id}`, { available: false });
  const soldOut = await srv.call(tokens.customer, 'POST', '/api/orders/quote', {
    restaurantId: 1, items: [{ menuItemId: item.id, quantity: 1, selections: { g0: ['o0'] } }], ...HOME,
  });
  assert.equal(soldOut.status, 409);
  assert.equal((await srv.call(tokens.merchant2, 'PATCH', `/api/merchant/restaurants/1/menu/${item.id}`, { price: 1 })).status, 404);
  assert.equal((await srv.call(tokens.merchant, 'DELETE', `/api/merchant/restaurants/1/menu/${item.id}`)).status, 204);
  const bad = await srv.call(tokens.merchant, 'POST', '/api/merchant/restaurants/1/menu', { name: 'X', price: -5 });
  assert.equal(bad.status, 400);
});

test('closed restaurants refuse orders', async () => {
  await srv.ok(tokens.merchant, 'PATCH', '/api/merchant/restaurants/1', { isOpen: false });
  assert.equal((await srv.call(tokens.customer, 'POST', '/api/orders', order())).status, 409);
  await srv.ok(tokens.merchant, 'PATCH', '/api/merchant/restaurants/1', { isOpen: true });
});
