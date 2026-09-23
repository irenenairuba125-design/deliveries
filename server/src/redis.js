// Optional Redis (REDIS_URL). Enables BullMQ jobs, the Socket.io Redis adapter
// (multiple server instances) and shared rate-limit counters.
import { Redis } from 'ioredis';

export const REDIS_URL = process.env.REDIS_URL || null;
const clients = [];

// BullMQ requires maxRetriesPerRequest: null on its connections.
export function redisClient(name) {
  const client = new Redis(REDIS_URL, { maxRetriesPerRequest: null, connectionName: `chakula:${name}` });
  client.on('error', (err) => console.error(`[redis:${name}] ${err.message}`));
  clients.push(client);
  return client;
}

export async function closeRedis() {
  await Promise.allSettled(clients.map((c) => c.quit()));
}
