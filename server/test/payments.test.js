// Live-provider code paths (Stripe, MTN MoMo, Airtel Money) against local fakes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startServer, HOME } from './helpers.js';
import { startMockProviders } from './mockProviders.js';

let srv;
let mock;
let customer;
let merchant;
let rolexId;

before(async () => {
  mock = await startMockProviders();
  srv = await startServer({ ...mock.env, PAYMENT_POLL_MS: '5000' }); // slow polling so webhooks are what settle
  [customer, merchant] = await Promise.all([srv.login('customer@demo.test'), srv.login('merchant@demo.test')]);
  rolexId = (await srv.ok(null, 'GET', '/api/restaurants/1')).menu.find((m) => m.name === 'Kikomando').id;
});
after(async () => {
  await srv?.stop();
  await mock?.close();
});

const body = (paymentMethod, phone) => ({
  restaurantId: 1, items: [{ menuItemId: rolexId, quantity: 1, selections: { spice: ['mild'] } }],
  ...HOME, address: 'Kampala Road', paymentMethod, phone,
});
const getOrder = async (id) => (await srv.ok(customer, 'GET', `/api/orders/${id}`)).order;
const stripeSig = (payload, secret = 'whsec_mock', t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;

test('payment config reports live/test providers', async () => {
  const cfg = await srv.ok(null, 'GET', '/api/payment-methods');
  const modes = Object.fromEntries(cfg.methods.map((m) => [m.id, m.mode]));
  assert.deepEqual(modes, { mtn_momo: 'test', airtel_money: 'test', card: 'test', cash: 'live' });
  assert.equal(cfg.stripePublishableKey, 'pk_test_mock');
});

test('MTN MoMo: request-to-pay, forged callback ignored, real status settles', async () => {
  const { order } = await srv.ok(customer, 'POST', '/api/orders', body('mtn_momo', '0772123456'));
  const [ref, tx] = [...mock.state.momo.entries()].at(-1);
  assert.equal(tx.body.payer.partyId, '256772123456');
  assert.equal(tx.body.externalId, String(order.id));
  assert.equal(tx.body.currency, 'EUR', 'sandbox target environment uses EUR');
  assert.equal(tx.callback, `https://example.test/api/payments/webhook/mtn_momo?ref=${ref}`);

  // A callback claiming success while MTN still says PENDING must not settle the order.
  await srv.ok(null, 'PUT', `/api/payments/webhook/mtn_momo?ref=${ref}`, { status: 'SUCCESSFUL', externalId: String(order.id) });
  assert.equal((await getOrder(order.id)).status, 'PENDING_PAYMENT');

  tx.status = 'SUCCESSFUL';
  await srv.ok(null, 'PUT', `/api/payments/webhook/mtn_momo?ref=${ref}`, { status: 'SUCCESSFUL' });
  const o = await getOrder(order.id);
  assert.equal(o.status, 'PLACED');
  assert.equal(o.payment.status, 'paid');

  // Refund without disbursement credentials is flagged for manual processing.
  const rejected = (await srv.ok(merchant, 'POST', `/api/orders/${order.id}/status`, { status: 'REJECTED' })).order;
  assert.equal(rejected.payment.status, 'refund_pending');
});

test('MTN MoMo: callback by externalId and failed payment', async () => {
  const { order } = await srv.ok(customer, 'POST', '/api/orders', body('mtn_momo', '0782123456'));
  const [, tx] = [...mock.state.momo.entries()].at(-1);
  tx.status = 'FAILED';
  await srv.ok(null, 'POST', '/api/payments/webhook/mtn_momo', { externalId: String(order.id), status: 'FAILED' });
  const o = await getOrder(order.id);
  assert.equal(o.status, 'CANCELLED');
  assert.equal(o.payment.status, 'failed');
});

test('Airtel Money: payment, status check endpoint, refund', async () => {
  const { order } = await srv.ok(customer, 'POST', '/api/orders', body('airtel_money', '0751234567'));
  const [id, tx] = [...mock.state.airtel.entries()].at(-1);
  assert.equal(tx.body.subscriber.msisdn, '751234567');
  assert.equal(tx.body.transaction.amount, order.total);

  assert.equal((await srv.ok(customer, 'POST', `/api/orders/${order.id}/payment/check`)).order.status, 'PENDING_PAYMENT');
  tx.status = 'TS';
  assert.equal((await srv.ok(customer, 'POST', `/api/orders/${order.id}/payment/check`)).order.status, 'PLACED');

  const cancelled = (await srv.ok(customer, 'POST', `/api/orders/${order.id}/status`, { status: 'CANCELLED' })).order;
  assert.equal(cancelled.payment.status, 'refunded');
  assert.deepEqual(mock.state.airtelRefunds, [`AM${id}`]);
});

test('Stripe: PaymentIntent, signed webhook settles, bad signatures rejected, refund', async () => {
  const created = await srv.ok(customer, 'POST', '/api/orders', body('card'));
  assert.equal(created.order.status, 'PENDING_PAYMENT');
  assert.match(created.clientSecret, /^pi_mock_\d+_secret/);
  const pi = created.order.payment.ref;
  assert.equal(mock.state.stripe.get(pi).amount, created.order.total);
  assert.equal(mock.state.stripe.get(pi).currency, 'ugx');
  assert.equal((await srv.ok(customer, 'GET', `/api/orders/${created.order.id}/payment`)).clientSecret, `${pi}_secret_abc`);

  const event = JSON.stringify({ type: 'payment_intent.succeeded', data: { object: { id: pi } } });
  const post = (sig, payload = event) => fetch(`${srv.base}/api/payments/webhook/stripe`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body: payload,
  });
  assert.equal((await post(stripeSig(event, 'whsec_wrong'))).status, 400);
  assert.equal((await post(stripeSig(event, 'whsec_mock', Math.floor(Date.now() / 1000) - 3600))).status, 400);
  assert.equal((await post('garbage')).status, 400);

  // Correctly signed, but Stripe itself doesn't report success yet -> no change.
  assert.equal((await post(stripeSig(event))).status, 200);
  assert.equal((await getOrder(created.order.id)).status, 'PENDING_PAYMENT');

  mock.state.stripe.get(pi).status = 'succeeded';
  assert.equal((await post(stripeSig(event))).status, 200);
  assert.equal((await getOrder(created.order.id)).status, 'PLACED');

  await srv.ok(merchant, 'POST', `/api/orders/${created.order.id}/status`, { status: 'REJECTED' });
  assert.deepEqual(mock.state.stripeRefunds, [pi]);
  assert.equal((await getOrder(created.order.id)).payment.status, 'refunded');
});

test('approving a payment after cancelling triggers a refund', async () => {
  const { order } = await srv.ok(customer, 'POST', '/api/orders', body('card'));
  await srv.ok(customer, 'POST', `/api/orders/${order.id}/status`, { status: 'CANCELLED' });
  assert.equal(mock.state.stripe.get(order.payment.ref).status, 'canceled', 'PaymentIntent cancelled with the order');

  const { order: o2 } = await srv.ok(customer, 'POST', '/api/orders', body('mtn_momo', '0772999888'));
  const [, tx] = [...mock.state.momo.entries()].at(-1);
  await srv.ok(customer, 'POST', `/api/orders/${o2.id}/status`, { status: 'CANCELLED' });
  tx.status = 'SUCCESSFUL'; // customer approves on the handset anyway
  await srv.ok(customer, 'POST', `/api/orders/${o2.id}/payment/check`);
  const after = await getOrder(o2.id);
  assert.equal(after.status, 'CANCELLED');
  assert.equal(after.payment.status, 'refund_pending');
});

test('provider outage fails the order cleanly', async () => {
  const bad = await startServer({ ...mock.env, MOMO_BASE_URL: 'http://127.0.0.1:1' });
  try {
    const c = await bad.login('customer@demo.test');
    const res = await bad.call(c, 'POST', '/api/orders', body('mtn_momo', '0772123456'));
    assert.equal(res.status, 502);
    const { orders } = await bad.ok(c, 'GET', '/api/orders');
    assert.equal(orders[0].status, 'CANCELLED');
  } finally {
    await bad.stop();
  }
});

test('rate limiting on login', async () => {
  const limited = await startServer({ RATE_LIMIT: 'on' });
  try {
    const statuses = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await limited.call(null, 'POST', '/api/auth/login', { email: 'customer@demo.test', password: 'wrong' })).status);
    }
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
    assert.deepEqual(statuses.slice(10), [429, 429]);
  } finally {
    await limited.stop();
  }
});

