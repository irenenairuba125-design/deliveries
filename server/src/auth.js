import crypto from 'node:crypto';
import { HttpError } from './errors.js';

const SECRET = process.env.AUTH_SECRET || 'dev-insecure-secret-change-me';
if (!process.env.AUTH_SECRET) {
  if (process.env.NODE_ENV === 'production') throw new Error('AUTH_SECRET must be set in production');
  console.warn('[auth] AUTH_SECRET not set; using an insecure development secret');
} else if (process.env.AUTH_SECRET.length < 32) {
  console.warn('[auth] AUTH_SECRET is short; use at least 32 random characters');
}
const TOKEN_TTL_SEC = 7 * 24 * 3600;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const sign = (body) => crypto.createHmac('sha256', SECRET).update(body).digest('base64url');

export function signToken(user) {
  const payload = {
    sub: user.id,
    role: user.role,
    name: user.name,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp < Date.now() / 1000) return null;
    return { id: payload.sub, role: payload.role, name: payload.name };
  } catch {
    return null;
  }
}

export function requireAuth(...roles) {
  return (req, _res, next) => {
    const header = req.headers.authorization ?? '';
    const user = verifyToken(header.startsWith('Bearer ') ? header.slice(7) : null);
    if (!user) throw new HttpError(401, 'Please sign in');
    if (roles.length && !roles.includes(user.role)) throw new HttpError(403, 'Not allowed for your role');
    req.user = user;
    next();
  };
}
