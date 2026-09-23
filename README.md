# Chakula — food delivery platform

Food ordering and delivery with live map tracking. Three portals share one codebase:

| Portal | URL | What it does |
|---|---|---|
| **Customer** | `/` | Find restaurants that deliver to you, search dishes, customise items (sizes, extras, spice level), check out with Mobile Money, card or cash, and watch the rider move on a live map with an ETA |
| **Restaurant** | `/merchant` | Live order board with a sound alert for new orders. Accept, reject or start cooking, and send the order to the nearest rider or pick one. Edit the menu, modifiers and stock, and open or close the store |
| **Driver** | `/driver` | Go online, get delivery requests with a 45 s countdown, accept or decline, follow the route, use Google Maps for turn-by-turn directions, and update the order status. GPS comes from the device or a simulated drive |

## Quick start

Requirements: **Node.js 22.13 or newer** (Node 24 recommended). No database server, Docker or API keys are needed.

```bash
npm install
npm run dev
```

- Web app: http://localhost:5173
- API and WebSocket server: http://localhost:4000

On first start the server creates `server/data/food.db` and fills it with demo data around Kampala. `npm run seed:reset` wipes the data and loads it again.

### Demo accounts (password `password123`)

| Role | Email |
|---|---|
| Customer | `customer@demo.test` |
| Restaurant (Rolex Republic, Kampala Pizza Co.) | `merchant@demo.test` |
| Restaurant (Spice Route, Green Bowl, Nile Burger) | `merchant2@demo.test` |
| Driver | `driver@demo.test`, `driver2@demo.test` |

The login page has one-click buttons for these accounts.

### A full order in about 2 minutes

Each role needs its own session, so open each one in a separate browser profile or incognito window.

1. **Driver**: sign in and click **Go online**. Keep "Simulated GPS" selected.
2. **Customer**: open Rolex Republic, add a Rolex with extras, and go to checkout. Pay with **MTN Mobile Money** using a number such as `0772123456`. The sandbox approves the payment after about 4 s.
3. **Restaurant**: the order appears under **New** with a chime. Click **Accept**, then **Auto-assign nearest rider**.
4. **Driver**: **Accept** the request.
5. **Restaurant**: click **Start cooking**.
6. **Driver**: click **▶ Simulate drive** (choose 10× or 25× speed), then **Picked up**, then **Start delivery**, then **Simulate drive** again.
7. **Customer**: the rider icon moves along the route and the ETA updates live.
8. **Driver**: finish with **Mark as delivered**.

In the payment sandbox, a Mobile Money number ending in `000` is declined, so you can see how a failed payment is handled.

To test with a real phone GPS, open the driver app from your phone on the same Wi-Fi (`http://<your-PC-IP>:5173`) and pick **Device GPS**. Browsers only allow location access on `localhost` or HTTPS, so for a phone use an HTTPS tunnel such as `ngrok http 5173`.

## Architecture

```
client/  React 19 + Vite + Leaflet + socket.io-client + Stripe.js
server/  Node + Express 5 + Socket.io
  src/
    index.js              startup (migrate, seed, jobs), static hosting of client/dist, shutdown
    db/                   one async API over two adapters:
      sqlite.js             node:sqlite, zero setup (default)
      postgres.js           pg pool; enables PostGIS automatically when installed
      schema.*.sql          schemas, applied on every start (idempotent)
    routes/api.js         REST API (auth, discovery, orders, merchant, driver, geo)
    routes/webhooks.js    Stripe / MTN MoMo / Airtel callbacks
    services/orders.js    pricing, checkout, payment settlement, transitions, dispatch
    services/payments.js  Stripe, MTN MoMo, Airtel Money clients + sandbox simulator
    services/tracking.js  live ETA (prep time + routed legs)
    jobs.js               delayed jobs: BullMQ on Redis, in-process timers otherwise
    realtime.js           Socket.io auth, rooms, Redis adapter
    sockets.js            driver GPS ingest -> fan-out to order rooms, ETA refresh
    rateLimit.js          login/register/order limits (Redis-backed when available)
    orderState.js         order state machine (who may move an order where)
    geo.js                haversine, routing (Mapbox -> OSRM -> estimate), geocoding
  test/                   integration tests (real server process + fake payment providers)
```

### Order lifecycle

```
PENDING_PAYMENT ─paid─▶ PLACED ─merchant─▶ ACCEPTED ─merchant─▶ IN_KITCHEN ─driver─▶ PICKED_UP ─driver─▶ ON_THE_WAY ─driver─▶ DELIVERED
       │                  │  └─merchant─▶ REJECTED        │                  │
       └─failed/timeout───┴─customer──▶ CANCELLED ◀───────┴──merchant────────┘
```

The server enforces every transition for each role (`orderState.js`). Each change is written to `order_events`, which drives the customer's timeline. Paid orders that are rejected or cancelled are refunded automatically.

A rider can be dispatched once an order is ACCEPTED or IN_KITCHEN. The restaurant offers the job to the nearest free online rider, or to one it picks. If the rider doesn't respond within 45 s, the offer expires. A rider has one active job at a time.

### Real-time tracking

1. The driver app sends `driver:location` over the WebSocket about once a second, from `watchPosition` or the simulator.
2. The server saves the position and relays it to the `order:<id>` room of every active order that rider has.
3. Every 10 s the server recalculates the ETA and sends it as `order:eta`, along with the route line:
   - before pickup: the longer of the rider's time to reach the restaurant and the remaining prep time, plus the restaurant-to-customer trip
   - after pickup: the rider-to-customer trip
4. The customer map moves the rider marker smoothly between updates.

Only users allowed to see an order can join its room: the customer who placed it, the restaurant owner and the assigned driver.

### Payments

Each payment method is **live** when its credentials are set. Without credentials, it runs as a **simulated sandbox** in development, and in production it is hidden from checkout (unless `PAYMENTS_SANDBOX=1`). Cash on delivery is always available unless `PAYMENTS_CASH=0`.

| Method | How it works |
|---|---|
| **MTN MoMo** | Collections `requesttopay` sends a PIN prompt to the customer's phone. The order settles when MTN reports `SUCCESSFUL`, found by polling every few seconds or triggered by MTN's callback. Automatic refunds need the Disbursement product keys; without them, refunds are marked *refund in progress* for manual handling. |
| **Airtel Money** | Collections `merchant/v1/payments` sends a PIN prompt. The status comes from `standard/v1/payments/{id}`, and refunds go through `standard/v1/payments/refund`. |
| **Card (Stripe)** | The server creates a PaymentIntent in UGX, and the customer pays with Stripe's Payment Element on the order page. Settlement comes through the signed webhook, with a status check as a fallback. Refunds use `/v1/refunds`. |

Webhooks never mark an order paid on their own. They only prompt the server to ask the provider for the real status, so a forged callback can't settle an order. Stripe webhook signatures are also verified. Pending payments time out (3 min for Mobile Money, 15 min for cards), and the order is then cancelled. If a customer cancels an order and approves the payment afterwards, the money is refunded automatically.

Callback URLs to register with each provider:
- Stripe: `https://<your-domain>/api/payments/webhook/stripe`, with events `payment_intent.succeeded`, `payment_intent.payment_failed` and `payment_intent.canceled`
- MTN: set `MOMO_CALLBACK_URL=https://<your-domain>/api/payments/webhook/mtn_momo`
- Airtel: `https://<your-domain>/api/payments/webhook/airtel_money`

### Geospatial queries

Radius search ("restaurants that deliver to me") checks each restaurant's own `delivery_radius_km`.
- **PostgreSQL with PostGIS:** the server detects the extension at startup and adds generated `geography` columns with GiST indexes. Queries then use `ST_DWithin` and `ST_Distance`.
- **Plain PostgreSQL or SQLite:** a bounding-box prefilter on the `(lat, lng)` index, then an exact `haversine_km()` check. That function is registered in SQLite and created as a SQL function in Postgres.

## Configuration

Copy `.env.example` to `.env` in the repo root, where both the server and Vite read it. Every variable is documented there. The main ones:

| Variable | Effect |
|---|---|
| `AUTH_SECRET` | Token signing secret. **Required** when `NODE_ENV=production` (at least 32 characters) |
| `DATABASE_URL` | `postgres://…` switches from SQLite to PostgreSQL, using PostGIS if installed |
| `REDIS_URL` | Turns on BullMQ jobs, the Socket.io Redis adapter and shared rate limits |
| `STRIPE_*`, `MOMO_*`, `AIRTEL_*` | Turns on live payments for that method |
| `MAPBOX_TOKEN` / `VITE_MAPBOX_TOKEN` | Traffic-aware routing and Mapbox map tiles |

If no router is reachable, ETAs fall back to straight-line distance × 1.35 at 22 km/h. The tracking card then shows "Estimated without live traffic".

## Tests

```bash
npm test                                             # SQLite, in-process jobs
TEST_DATABASE_URL=postgres://… npm test              # same suite on PostgreSQL (tables are dropped!)
TEST_REDIS_URL=redis://localhost:6379 npm test       # with BullMQ + Redis adapter (the Redis db is flushed!)
```

The suite starts real server processes. It covers:
- the whole order lifecycle over HTTP and WebSockets
- permissions, and pricing and modifier validation
- dispatch expiry, concurrent status changes, menu management and rate limiting
- the live Stripe, MTN MoMo and Airtel code paths, run against local fake provider APIs: signatures, forged callbacks, refunds and provider outages

## Deploying

With Docker, this runs the app, PostgreSQL + PostGIS and Redis:

```bash
cp .env.example .env        # set AUTH_SECRET, payment keys, MAPBOX tokens
docker compose up --build   # http://localhost:4000
```

Without Docker:

```bash
npm ci && npm run build
NODE_ENV=production DATABASE_URL=… REDIS_URL=… AUTH_SECRET=… npm start
```

Before going live:
- **HTTPS:** serve over HTTPS, because phones only allow GPS on secure origins. If you're behind a proxy, set `TRUST_PROXY=1` so rate limits see real client IPs.
- **Several instances:** set `REDIS_URL`, and use a load balancer that supports WebSockets. The client connects over WebSocket first, so sticky sessions are only needed for the long-polling fallback.
- **Schema and accounts:** the schema is created on startup. Demo data is not seeded in production unless `SEED_DEMO=1`. Create real accounts with `npm run create-account -- --role merchant --email … --name … --password … --restaurant … --address … --lat … --lng …` (or `--role driver`). Restaurants then build their menu in the Restaurant portal.
- **Health check:** `GET /api/health` reports which database, PostGIS and Redis the server is using.

## Still to build

- **Onboarding:** there are no self-service sign-up screens for restaurants or drivers. An operator creates their accounts with `npm run create-account`.
- **Admin:** there's no admin console. Payouts to restaurants and drivers aren't covered, and neither are refunds for MoMo when the Disbursement product isn't set up.
- **Account security:** there are no refresh tokens, password reset, or phone OTP login.
- **Notifications:** there are no push notifications (FCM or APNs) for riders when the app is in the background. Offers arrive over the open WebSocket.
- **Map services:** OpenStreetMap tiles and Nominatim geocoding have fair-use limits. Switch to Mapbox or Google for production traffic.
