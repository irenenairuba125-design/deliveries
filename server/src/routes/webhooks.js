// Payment provider callbacks. Mounted before express.json() because Stripe's
// signature is computed over the raw body.
//
// MoMo and Airtel callbacks aren't signed in a way we can rely on, so they are
// treated purely as "something changed" hints: syncPayment() asks the provider
// API for the real status before touching the order.
import express, { Router } from 'express';
import { syncPayment } from '../services/orders.js';
import { verifyStripeSignature } from '../services/payments.js';

export const webhooks = Router();

const STRIPE_EVENTS = new Set([
  'payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled',
]);

webhooks.post('/stripe', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const event = verifyStripeSignature(req.body.toString('utf8'), req.headers['stripe-signature']);
  if (STRIPE_EVENTS.has(event.type)) await syncPayment({ ref: event.data.object.id });
  res.json({ received: true });
});

const jsonBody = express.json({ limit: '100kb' });

// MTN sends the request-to-pay result to X-Callback-Url (PUT in sandbox, POST in some markets).
webhooks.all('/mtn_momo', jsonBody, async (req, res) => {
  // We append ?ref=<X-Reference-Id> to the callback URL; the body only carries externalId (= order id).
  const ref = req.query.ref ?? req.body?.referenceId;
  const orderId = Number(req.body?.externalId);
  if (ref) await syncPayment({ ref: String(ref) });
  else if (Number.isInteger(orderId)) await syncPayment({ orderId });
  res.json({ received: true });
});

webhooks.post('/airtel_money', jsonBody, async (req, res) => {
  const ref = req.body?.transaction?.id;
  if (ref) await syncPayment({ ref: String(ref) });
  res.json({ received: true });
});
