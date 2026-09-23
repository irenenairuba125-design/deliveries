// Starts a real server process for integration tests.
//   TEST_DATABASE_URL=postgres://…  run against PostgreSQL (tables are wiped first)
//   TEST_REDIS_URL=redis://…        run with BullMQ + Socket.io Redis adapter
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { io } from 'socket.io-client';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () =>
  new Promise((resolve) => {
    const srv = net.createServer().listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

export async function startServer(extraEnv = {}) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chakula-test-'));
  const env = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dir, 'test.db'),
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
    REDIS_URL: process.env.TEST_REDIS_URL ?? '',
    OSRM_URL: 'off',
    AUTH_SECRET: 'test-secret-test-secret-test-secret-123',
    PAYMENT_POLL_MS: '200',
    SANDBOX_SETTLE_MS: '600',
    RATE_LIMIT: 'off',
    NODE_ENV: 'test',
    ...extraEnv,
  };
  if (env.DATABASE_URL) await resetPostgres(env.DATABASE_URL);
  if (env.REDIS_URL) await flushRedis(env.REDIS_URL);

  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], {
    cwd: path.join(import.meta.dirname, '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`server exited:\n${log}`);
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }

  const sockets = [];
  return {
    base,
    log: () => log,
    async call(token, method, p, body) {
      const res = await fetch(base + p, {
        method,
        headers: { ...(body !== undefined && { 'content-type': 'application/json' }), ...(token && { authorization: `Bearer ${token}` }) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
      return { status: res.status, data };
    },
    async ok(token, method, p, body) {
      const r = await this.call(token, method, p, body);
      if (r.status >= 400) throw new Error(`${method} ${p} -> ${r.status} ${r.data.error}`);
      return r.data;
    },
    async login(email) {
      return (await this.ok(null, 'POST', '/api/auth/login', { email, password: 'password123' })).token;
    },
    socket(token) {
      const s = io(base, { auth: { token }, transports: ['websocket'] });
      sockets.push(s);
      return new Promise((resolve, reject) => {
        s.on('connect', () => resolve(s));
        s.on('connect_error', reject);
      });
    },
    async stop() {
      sockets.forEach((s) => s.disconnect());
      child.kill('SIGTERM');
      await new Promise((r) => (child.exitCode !== null ? r() : child.on('exit', r)));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function waitFor(fn, { timeout = 8000, interval = 100, label = 'condition' } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// Resolves with the first event payload that matches.
export function nextEvent(socket, event, match = () => true, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no ${event} within ${timeout}ms`)), timeout);
    const handler = (payload) => {
      if (!match(payload)) return;
      clearTimeout(t);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

async function resetPostgres(url) {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('DROP TABLE IF EXISTS order_events, order_items, orders, menu_items, drivers, restaurants, users CASCADE');
  await client.end();
}

async function flushRedis(url) {
  const { Redis } = await import('ioredis');
  const r = new Redis(url);
  await r.flushdb();
  await r.quit();
}

export const HOME = { lat: 0.3136, lng: 32.5811 };
