// Payment providers. Each method runs LIVE when its credentials are configured,
// otherwise in SANDBOX mode (simulated, allowed outside production or with
// PAYMENTS_SANDBOX=1), otherwise it isn't offered at checkout.
//
// Provider interface:
//   start({ amount, phone, orderId })  -> { status: 'paid'|'pending'|'failed', ref, message?, clientSecret? }
//   check(ref)                          -> 'paid' | 'failed' | 'pending'   (authoritative status from provider)
//   cancel?(ref)                        -> void (give up on a pending payment)
//   refund(ref, amount)                 -> 'refunded' | 'refund_pending'
//
// Webhooks never settle an order by themselves: they only trigger check(ref),
// so a forged callback can't mark an order paid.
import crypto from 'node:crypto';
import { HttpError } from '../errors.js';

const env = process.env;
const SANDBOX_ALLOWED = env.NODE_ENV !== 'production' || env.PAYMENTS_SANDBOX === '1';
const SANDBOX_PREFIX = 'sbx_';
const SANDBOX_SETTLE_MS = Number(env.SANDBOX_SETTLE_MS) || 4000;

const MTN_PREFIXES = ['076', '077', '078', '079'];
const AIRTEL_PREFIXES = ['070', '074', '075'];

// ---------- helpers ----------

export function normalizeUgPhone(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (/^2567\d{8}$/.test(digits)) return `0${digits.slice(3)}`;
  if (/^07\d{8}$/.test(digits)) return digits;
  return null;
}
const toMsisdn = (local) => `256${local.slice(1)}`; // 0772123456 -> 256772123456

async function http(url, { method = 'GET', headers = {}, json, form, timeoutMs = 15000 } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      ...(json !== undefined && { 'Content-Type': 'application/json' }),
      ...(form !== undefined && { 'Content-Type': 'application/x-www-form-urlencoded' }),
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : form !== undefined ? new URLSearchParams(form).toString() : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`${method} ${new URL(url).pathname} -> ${res.status} ${text.slice(0, 200)}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return { status: res.status, data };
}

// Caches an OAuth-style token until shortly before it expires.
function tokenCache(fetchToken) {
  let token = null;
  let expiresAt = 0;
  return async () => {
    if (token && Date.now() < expiresAt) return token;
    const { accessToken, expiresInSec } = await fetchToken();
    token = accessToken;
    expiresAt = Date.now() + Math.max(30, expiresInSec - 60) * 1000;
    return token;
  };
}

// ---------- sandbox (simulated) ----------

const sandboxPayments = new Map(); // ref -> { settleAt, approve }

function sandboxProvider({ instant }) {
  return {
    mode: 'sandbox',
    async start({ phone }) {
      const ref = `${SANDBOX_PREFIX}${crypto.randomBytes(8).toString('hex')}`;
      if (instant) return { status: 'paid', ref };
      // Numbers ending in 000 are declined so the failure path can be exercised.
      sandboxPayments.set(ref, { settleAt: Date.now() + SANDBOX_SETTLE_MS, approve: !phone.endsWith('000') });
      return { status: 'pending', ref, message: `Approve the payment prompt on ${phone} to confirm your order (sandbox: auto-approves in a few seconds).` };
    },
    async check(ref) {
      const p = sandboxPayments.get(ref);
      if (!p) return instant ? 'paid' : 'failed';
      if (Date.now() < p.settleAt) return 'pending';
      return p.approve ? 'paid' : 'failed';
    },
    async cancel(ref) {
      sandboxPayments.delete(ref);
    },
    async refund() {
      return 'refunded';
    },
  };
}

// ---------- Stripe (cards) ----------

function stripeProvider() {
  const base = env.STRIPE_API_BASE || 'https://api.stripe.com';
  const currency = (env.STRIPE_CURRENCY || 'ugx').toLowerCase();
  const auth = { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` };
  const live = env.STRIPE_SECRET_KEY.startsWith('sk_live');
  return {
    mode: live ? 'live' : 'test',
    publishableKey: env.STRIPE_PUBLISHABLE_KEY || null,
    async start({ amount, orderId }) {
      // UGX is a zero-decimal currency in Stripe, so the amount is sent as-is.
      const { data } = await http(`${base}/v1/payment_intents`, {
        method: 'POST',
        headers: { ...auth, 'Idempotency-Key': `order-${orderId}` },
        form: {
          amount: String(amount),
          currency,
          'automatic_payment_methods[enabled]': 'true',
          'metadata[order_id]': String(orderId),
          description: `Chakula order #${orderId}`,
        },
      });
      return { status: 'pending', ref: data.id, clientSecret: data.client_secret, message: 'Enter your card details to pay.' };
    },
    async check(ref) {
      const { data } = await http(`${base}/v1/payment_intents/${ref}`, { headers: auth });
      if (data.status === 'succeeded') return 'paid';
      if (data.status === 'canceled') return 'failed';
      return 'pending';
    },
    async clientSecret(ref) {
      const { data } = await http(`${base}/v1/payment_intents/${ref}`, { headers: auth });
      return data.client_secret;
    },
    async cancel(ref) {
      await http(`${base}/v1/payment_intents/${ref}/cancel`, { method: 'POST', headers: auth, form: {} }).catch(() => {});
    },
    async refund(ref) {
      await http(`${base}/v1/refunds`, { method: 'POST', headers: { ...auth, 'Idempotency-Key': `refund-${ref}` }, form: { payment_intent: ref } });
      return 'refunded';
    },
  };
}

// Stripe-Signature: t=<unix>,v1=<hex hmac of "t.payload">
export function verifyStripeSignature(rawBody, header, secret = env.STRIPE_WEBHOOK_SECRET, toleranceSec = 300) {
  if (!secret) throw new HttpError(503, 'Stripe webhooks are not configured');
  const parts = Object.fromEntries(
    String(header ?? '').split(',').map((kv) => kv.split('=')).filter(([k, v]) => k && v).map(([k, v]) => [k.trim(), v]),
  );
  const signatures = String(header ?? '').split(',').filter((kv) => kv.trim().startsWith('v1=')).map((kv) => kv.trim().slice(3));
  const t = Number(parts.t);
  if (!t || !signatures.length) throw new HttpError(400, 'Invalid Stripe signature header');
  if (Math.abs(Date.now() / 1000 - t) > toleranceSec) throw new HttpError(400, 'Stripe signature timestamp outside tolerance');
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const ok = signatures.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  if (!ok) throw new HttpError(400, 'Stripe signature mismatch');
  return JSON.parse(rawBody);
}

// ---------- MTN Mobile Money (Collections API) ----------

function mtnProvider() {
  const base = env.MOMO_BASE_URL || 'https://sandbox.momodeveloper.mtn.com';
  const targetEnv = env.MOMO_TARGET_ENV || 'sandbox'; // e.g. mtnuganda in production
  const currency = env.MOMO_CURRENCY || (targetEnv === 'sandbox' ? 'EUR' : 'UGX');
  const collectionKey = env.MOMO_SUBSCRIPTION_KEY;

  const collectionToken = tokenCache(async () => {
    const basic = Buffer.from(`${env.MOMO_API_USER}:${env.MOMO_API_KEY}`).toString('base64');
    const { data } = await http(`${base}/collection/token/`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Ocp-Apim-Subscription-Key': collectionKey },
    });
    return { accessToken: data.access_token, expiresInSec: data.expires_in };
  });

  const hasDisbursement = env.MOMO_DISBURSEMENT_SUBSCRIPTION_KEY && env.MOMO_DISBURSEMENT_API_USER && env.MOMO_DISBURSEMENT_API_KEY;
  const disbursementToken = hasDisbursement && tokenCache(async () => {
    const basic = Buffer.from(`${env.MOMO_DISBURSEMENT_API_USER}:${env.MOMO_DISBURSEMENT_API_KEY}`).toString('base64');
    const { data } = await http(`${base}/disbursement/token/`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Ocp-Apim-Subscription-Key': env.MOMO_DISBURSEMENT_SUBSCRIPTION_KEY },
    });
    return { accessToken: data.access_token, expiresInSec: data.expires_in };
  });

  const headers = async () => ({
    Authorization: `Bearer ${await collectionToken()}`,
    'X-Target-Environment': targetEnv,
    'Ocp-Apim-Subscription-Key': collectionKey,
  });

  return {
    mode: targetEnv === 'sandbox' ? 'test' : 'live',
    async start({ amount, phone, orderId }) {
      const ref = crypto.randomUUID(); // MoMo requires a UUID v4 X-Reference-Id
      await http(`${base}/collection/v1_0/requesttopay`, {
        method: 'POST',
        headers: {
          ...(await headers()),
          'X-Reference-Id': ref,
          ...(env.MOMO_CALLBACK_URL && { 'X-Callback-Url': `${env.MOMO_CALLBACK_URL}?ref=${ref}` }),
        },
        json: {
          amount: String(amount),
          currency,
          externalId: String(orderId),
          payer: { partyIdType: 'MSISDN', partyId: toMsisdn(phone) },
          payerMessage: `Chakula order #${orderId}`,
          payeeNote: `Order #${orderId}`,
        },
      });
      return { status: 'pending', ref, message: `Check your phone (${phone}) and enter your MoMo PIN to approve the payment.` };
    },
    async check(ref) {
      const { data } = await http(`${base}/collection/v1_0/requesttopay/${ref}`, { headers: await headers() });
      if (data.status === 'SUCCESSFUL') return 'paid';
      if (data.status === 'PENDING') return 'pending';
      return 'failed'; // FAILED, REJECTED, TIMEOUT, ...
    },
    async refund(ref, amount) {
      if (!hasDisbursement) return 'refund_pending'; // needs manual refund from the MoMo portal
      await http(`${base}/disbursement/v2_0/refund`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await disbursementToken()}`,
          'X-Target-Environment': targetEnv,
          'Ocp-Apim-Subscription-Key': env.MOMO_DISBURSEMENT_SUBSCRIPTION_KEY,
          'X-Reference-Id': crypto.randomUUID(),
        },
        json: {
          amount: String(amount), currency, externalId: ref, payerMessage: 'Chakula refund', payeeNote: 'Refund', referenceIdToRefund: ref,
        },
      });
      return 'refunded';
    },
  };
}

// ---------- Airtel Money (Africa Collections API) ----------

function airtelProvider() {
  const live = env.AIRTEL_ENV === 'production';
  const base = env.AIRTEL_BASE_URL || (live ? 'https://openapi.airtel.africa' : 'https://openapiuat.airtel.africa');
  const country = env.AIRTEL_COUNTRY || 'UG';
  const currency = env.AIRTEL_CURRENCY || 'UGX';

  const token = tokenCache(async () => {
    const { data } = await http(`${base}/auth/oauth2/token`, {
      method: 'POST',
      json: { client_id: env.AIRTEL_CLIENT_ID, client_secret: env.AIRTEL_CLIENT_SECRET, grant_type: 'client_credentials' },
    });
    return { accessToken: data.access_token, expiresInSec: Number(data.expires_in) || 180 };
  });
  const headers = async () => ({ Authorization: `Bearer ${await token()}`, 'X-Country': country, 'X-Currency': currency, Accept: '*/*' });

  async function status(ref) {
    const { data } = await http(`${base}/standard/v1/payments/${ref}`, { headers: await headers() });
    return data?.data?.transaction ?? {};
  }

  return {
    mode: live ? 'live' : 'test',
    async start({ amount, phone, orderId }) {
      const ref = `CHK${orderId}${crypto.randomBytes(4).toString('hex')}`.toUpperCase();
      const { data } = await http(`${base}/merchant/v1/payments/`, {
        method: 'POST',
        headers: await headers(),
        json: {
          reference: `Chakula order ${orderId}`,
          subscriber: { country, currency, msisdn: phone.slice(1) }, // without country code
          transaction: { amount, country, currency, id: ref },
        },
      });
      if (data?.status?.success === false) {
        return { status: 'failed', ref, message: data.status.message || 'Airtel Money rejected the request' };
      }
      return { status: 'pending', ref, message: `Check your phone (${phone}) and enter your Airtel Money PIN to approve the payment.` };
    },
    async check(ref) {
      const s = (await status(ref)).status;
      if (s === 'TS') return 'paid';
      if (s === 'TF' || s === 'TE') return 'failed';
      return 'pending'; // TIP (in progress), TA (ambiguous) -> keep polling
    },
    async refund(ref) {
      const airtelMoneyId = (await status(ref)).airtel_money_id;
      if (!airtelMoneyId) return 'refund_pending';
      await http(`${base}/standard/v1/payments/refund`, {
        method: 'POST',
        headers: await headers(),
        json: { transaction: { airtel_money_id: airtelMoneyId } },
      });
      return 'refunded';
    },
  };
}

// ---------- registry ----------

const cash = {
  mode: 'live',
  async start() {
    return { status: 'cod', ref: null };
  },
  async check() {
    return 'pending';
  },
  async refund() {
    return 'refunded';
  },
};

const METHOD_LABELS = {
  mtn_momo: 'MTN Mobile Money',
  airtel_money: 'Airtel Money',
  card: 'Card',
  cash: 'Cash on delivery',
};

function build() {
  const pick = (configured, live, sandboxOpts) => (configured ? live() : SANDBOX_ALLOWED ? sandboxProvider(sandboxOpts) : null);
  return {
    mtn_momo: pick(env.MOMO_SUBSCRIPTION_KEY && env.MOMO_API_USER && env.MOMO_API_KEY, mtnProvider, { instant: false }),
    airtel_money: pick(env.AIRTEL_CLIENT_ID && env.AIRTEL_CLIENT_SECRET, airtelProvider, { instant: false }),
    card: pick(env.STRIPE_SECRET_KEY, stripeProvider, { instant: true }),
    cash: env.PAYMENTS_CASH === '0' ? null : cash,
  };
}

const providers = build();
const sandboxes = { mtn_momo: sandboxProvider({ instant: false }), airtel_money: sandboxProvider({ instant: false }), card: sandboxProvider({ instant: true }) };

function providerFor(method, ref) {
  // Payments started in sandbox stay in sandbox even if keys are added later.
  if (ref?.startsWith(SANDBOX_PREFIX)) return sandboxes[method];
  const p = providers[method];
  if (!p) throw new HttpError(400, 'This payment method is not available');
  return p;
}

export function paymentConfig() {
  return {
    methods: Object.entries(providers)
      .filter(([, p]) => p)
      .map(([id, p]) => ({ id, label: METHOD_LABELS[id], mode: p.mode, needsPhone: id === 'mtn_momo' || id === 'airtel_money' })),
    stripePublishableKey: providers.card?.publishableKey ?? null,
  };
}

export function validatePaymentInput(method, phone) {
  if (!providers[method]) throw new HttpError(400, 'This payment method is not available');
  if (method !== 'mtn_momo' && method !== 'airtel_money') return null;
  const normalized = normalizeUgPhone(phone);
  if (!normalized) throw new HttpError(400, 'Enter a valid Ugandan mobile number, e.g. 0772 123456');
  const prefixes = method === 'mtn_momo' ? MTN_PREFIXES : AIRTEL_PREFIXES;
  if (!prefixes.includes(normalized.slice(0, 3))) {
    throw new HttpError(400, `${normalized} is not an ${METHOD_LABELS[method]} number`);
  }
  return normalized;
}

export const initiatePayment = ({ method, amount, phone, orderId }) => providerFor(method).start({ amount, phone, orderId });
export const checkPayment = (method, ref) => providerFor(method, ref).check(ref);
export const cancelPayment = async (method, ref) => providerFor(method, ref).cancel?.(ref);
export const refundPayment = (method, ref, amount) => providerFor(method, ref).refund(ref, amount);
export const stripeClientSecret = (ref) => providers.card?.clientSecret?.(ref) ?? null;
export const isSandboxRef = (ref) => Boolean(ref?.startsWith(SANDBOX_PREFIX));
