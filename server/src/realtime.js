// Socket.io rooms:
//   user:<id>        every signed-in user (order updates, dispatch offers)
//   restaurant:<id>  merchants who own the restaurant (incoming orders)
//   order:<id>       anyone allowed to watch that order (live driver location + ETA)
// With REDIS_URL, the Redis adapter relays events between server instances.
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { verifyToken } from './auth.js';
import { db } from './db/index.js';
import { REDIS_URL, redisClient } from './redis.js';

let io = null;

export function initRealtime(httpServer, registerHandlers) {
  io = new Server(httpServer, {
    cors: { origin: process.env.CORS_ORIGIN?.split(',') ?? true, credentials: true },
    ...(REDIS_URL && { adapter: createAdapter(redisClient('io-pub'), redisClient('io-sub')) }),
  });

  io.use((socket, next) => {
    const user = verifyToken(socket.handshake.auth?.token);
    if (!user) return next(new Error('unauthorized'));
    socket.data.user = user;
    next();
  });

  io.on('connection', async (socket) => {
    const { user } = socket.data;
    // Register handlers first so no early client event is missed while we query.
    registerHandlers(io, socket);
    socket.join(`user:${user.id}`);
    if (user.role === 'merchant') {
      const owned = await db.all('SELECT id FROM restaurants WHERE owner_id = ?', [user.id]);
      socket.join(owned.map(({ id }) => `restaurant:${id}`));
    }
  });
  return io;
}

export function joinRestaurantRoom(ownerId, restaurantId) {
  io?.in(`user:${ownerId}`).socketsJoin(`restaurant:${restaurantId}`);
}

export function emitTo(rooms, event, payload) {
  if (!io) return;
  const targets = rooms.filter(Boolean);
  if (targets.length) io.to(targets).emit(event, payload);
}

export const closeRealtime = () => new Promise((resolve) => (io ? io.close(() => resolve()) : resolve()));
