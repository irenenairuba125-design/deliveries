// Delayed background jobs (dispatch offer expiry, payment polling/timeouts).
// With REDIS_URL they run on BullMQ, so they survive restarts and are shared by
// all instances; otherwise they run as in-process timers.
// Handlers must be idempotent: a job may fire after the state it guards changed.
import { Queue, Worker } from 'bullmq';
import { REDIS_URL, redisClient } from './redis.js';

const QUEUE = 'chakula-jobs';
const handlers = new Map();
let queue = null;
let worker = null;
const timers = new Set();

export function defineJob(name, handler) {
  handlers.set(name, handler);
}

async function run(name, data) {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`No handler for job ${name}`);
  await handler(data);
}

export async function startJobs() {
  if (!REDIS_URL) {
    console.log('[jobs] in-process timers (set REDIS_URL to use BullMQ)');
    return;
  }
  queue = new Queue(QUEUE, { connection: redisClient('queue') });
  worker = new Worker(QUEUE, (job) => run(job.name, job.data), { connection: redisClient('worker'), concurrency: 10 });
  worker.on('failed', (job, err) => console.error(`[jobs] ${job?.name} failed: ${err.message}`));
  console.log('[jobs] BullMQ worker started');
}

export async function schedule(name, data, delayMs) {
  if (queue) {
    await queue.add(name, data, {
      delay: delayMs,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
    return;
  }
  const t = setTimeout(() => {
    timers.delete(t);
    run(name, data).catch((err) => console.error(`[jobs] ${name} failed: ${err.message}`));
  }, delayMs);
  t.unref?.();
  timers.add(t);
}

export async function stopJobs() {
  for (const t of timers) clearTimeout(t);
  timers.clear();
  await worker?.close();
  await queue?.close();
}
