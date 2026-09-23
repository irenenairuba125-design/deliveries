// In-process fakes of the Stripe, MTN MoMo and Airtel Money HTTP APIs, so the
// live provider code paths can be exercised without real credentials.
import http from 'node:http';

export async function startMockProviders() {
  const state = {
    stripe: new Map(), // pi id -> { status, amount, currency }
    stripeRefunds: [],
    momo: new Map(), // ref -> { status, body }
    airtel: new Map(), // id -> { status, body }
    airtelRefunds: [],
    requests: [],
  };
  let seq = 0;

  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    state.requests.push({ method: req.method, path: p, headers: req.headers, raw });
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    const json = () => (raw ? JSON.parse(raw) : {});
    const form = () => Object.fromEntries(new URLSearchParams(raw));
    const bearer = req.headers.authorization?.startsWith('Bearer ');

    // ---- Stripe ----
    if (p === '/v1/payment_intents' && req.method === 'POST') {
      if (req.headers.authorization !== 'Bearer sk_test_mock') return send(401, { error: { message: 'bad key' } });
      const f = form();
      const id = `pi_mock_${++seq}`;
      state.stripe.set(id, { status: 'requires_payment_method', amount: Number(f.amount), currency: f.currency });
      return send(200, { id, client_secret: `${id}_secret_abc`, status: 'requires_payment_method' });
    }
    let m = p.match(/^\/v1\/payment_intents\/([^/]+)(\/cancel)?$/);
    if (m) {
      const pi = state.stripe.get(m[1]);
      if (!pi) return send(404, { error: { message: 'no such pi' } });
      if (m[2]) pi.status = 'canceled';
      return send(200, { id: m[1], client_secret: `${m[1]}_secret_abc`, ...pi });
    }
    if (p === '/v1/refunds' && req.method === 'POST') {
      state.stripeRefunds.push(form().payment_intent);
      return send(200, { id: `re_${++seq}`, status: 'succeeded' });
    }

    // ---- MTN MoMo ----
    if (p === '/collection/token/' && req.method === 'POST') {
      const expected = `Basic ${Buffer.from('momo-user:momo-key').toString('base64')}`;
      if (req.headers.authorization !== expected || req.headers['ocp-apim-subscription-key'] !== 'momo-sub') return send(401, {});
      return send(200, { access_token: 'momo-token', token_type: 'access_token', expires_in: 3600 });
    }
    if (p === '/collection/v1_0/requesttopay' && req.method === 'POST') {
      if (req.headers.authorization !== 'Bearer momo-token' || !req.headers['x-reference-id']) return send(401, {});
      state.momo.set(req.headers['x-reference-id'], { status: 'PENDING', body: json(), callback: req.headers['x-callback-url'] });
      return send(202);
    }
    m = p.match(/^\/collection\/v1_0\/requesttopay\/(.+)$/);
    if (m) {
      const tx = state.momo.get(m[1]);
      return tx ? send(200, { status: tx.status, externalId: tx.body.externalId }) : send(404, {});
    }

    // ---- Airtel ----
    if (p === '/auth/oauth2/token' && req.method === 'POST') {
      const b = json();
      if (b.client_id !== 'airtel-id' || b.client_secret !== 'airtel-secret') return send(401, {});
      return send(200, { access_token: 'airtel-token', expires_in: '180', token_type: 'bearer' });
    }
    if (p === '/merchant/v1/payments/' && req.method === 'POST') {
      if (!bearer) return send(401, {});
      const b = json();
      state.airtel.set(b.transaction.id, { status: 'TIP', body: b });
      return send(200, { data: { transaction: { id: b.transaction.id, status: 'Success.' } }, status: { success: true, code: '200' } });
    }
    m = p.match(/^\/standard\/v1\/payments\/(.+)$/);
    if (m && req.method === 'GET' && m[1] !== 'refund') {
      const tx = state.airtel.get(m[1]);
      return tx
        ? send(200, { data: { transaction: { id: m[1], status: tx.status, airtel_money_id: `AM${m[1]}` } }, status: { success: true } })
        : send(404, {});
    }
    if (p === '/standard/v1/payments/refund' && req.method === 'POST') {
      state.airtelRefunds.push(json().transaction.airtel_money_id);
      return send(200, { data: { transaction: { status: 'SUCCESS' } }, status: { success: true } });
    }

    send(404, { error: `mock: no route ${req.method} ${p}` });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    state,
    env: {
      STRIPE_SECRET_KEY: 'sk_test_mock',
      STRIPE_PUBLISHABLE_KEY: 'pk_test_mock',
      STRIPE_WEBHOOK_SECRET: 'whsec_mock',
      STRIPE_API_BASE: base,
      MOMO_BASE_URL: base,
      MOMO_SUBSCRIPTION_KEY: 'momo-sub',
      MOMO_API_USER: 'momo-user',
      MOMO_API_KEY: 'momo-key',
      MOMO_TARGET_ENV: 'sandbox',
      MOMO_CALLBACK_URL: 'https://example.test/api/payments/webhook/mtn_momo',
      AIRTEL_BASE_URL: base,
      AIRTEL_CLIENT_ID: 'airtel-id',
      AIRTEL_CLIENT_SECRET: 'airtel-secret',
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
