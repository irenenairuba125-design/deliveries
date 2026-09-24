import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import cors from 'cors';
import { db } from './db/index.js';
import { seedIfEmpty } from './seed.js';
import { api } from './routes/api.js';
import { webhooks } from './routes/webhooks.js';
import { initRealtime, closeRealtime } from './realtime.js';
import { registerSocketHandlers } from './sockets.js';
import { startJobs, stopJobs } from './jobs.js';
import { closeRedis, REDIS_URL } from './redis.js';

const PORT = Number(process.env.PORT) || 4000;
const PROD = process.env.NODE_ENV === 'production';

await db.migrate();
// Demo data is seeded in development, or in production only when asked for.
if (!PROD || process.env.SEED_DEMO === '1') await seedIfEmpty();
// Single-instance dev: nobody is connected right after a restart. With Redis
// (possibly several instances) presence is left alone.
if (!REDIS_URL) await db.run('UPDATE drivers SET is_online = 0');
await startJobs();

const app = express();
app.disable('x-powered-by');
// 'true', a hop count (e.g. 1), or a list of proxy addresses.
const trustProxy = process.env.TRUST_PROXY;
if (trustProxy) app.set('trust proxy', trustProxy === 'true' ? true : /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') ?? true }));
app.use((_req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY' });
  next();
});

app.use('/api/payments/webhook', webhooks);
app.use(express.json({ limit: '100kb' }));
app.get('/api/health', async (_req, res) => {
  await db.get('SELECT 1 AS ok');
  res.json({ ok: true, db: db.dialect, postgis: db.postgis, redis: Boolean(REDIS_URL) });
});
app.use('/api', api);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// Serve the built client (`npm run build`) from the same origin.
const clientDist = path.join(import.meta.dirname, '..', '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist, { index: false, maxAge: '1h' }));
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

app.use((err, _req, res, _next) => {
  const status = err.status ?? (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong' : err.message });
});

const server = http.createServer(app);
initRealtime(server, registerSocketHandlers);
server.listen(PORT, () => console.log(`[server] http://localhost:${PORT} (db: ${db.dialect}${db.postgis ? '+postgis' : ''}, redis: ${REDIS_URL ? 'on' : 'off'})`));

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, shutting down`);
  setTimeout(() => process.exit(1), 10_000).unref();
  server.close();
  await closeRealtime();
  await stopJobs();
  await closeRedis();
  await db.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
