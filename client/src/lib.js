import { io } from 'socket.io-client';

// ---------- storage (can throw in private mode) ----------
export const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  },
};

// ---------- REST ----------
export async function api(path, { method = 'GET', body } = {}) {
  const token = store.get('token');
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------- realtime ----------
let socket = null;
export function getSocket() {
  const token = store.get('token');
  if (!token) return null;
  if (!socket) socket = io({ auth: { token }, transports: ['websocket', 'polling'] });
  return socket;
}
export function closeSocket() {
  socket?.disconnect();
  socket = null;
}

// ---------- formatting ----------
export const ugx = (n) => `UGX ${Math.round(n ?? 0).toLocaleString('en-US')}`;
export const km = (n) => (n < 1 ? `${Math.round(n * 1000)} m` : `${n.toFixed(1)} km`);
export function minutes(sec) {
  if (sec == null) return '–';
  const m = Math.max(1, Math.round(sec / 60));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}
export const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export const STATUS_LABEL = {
  PENDING_PAYMENT: 'Awaiting payment',
  PLACED: 'Order placed',
  ACCEPTED: 'Accepted by restaurant',
  IN_KITCHEN: 'In the kitchen',
  PICKED_UP: 'Picked up',
  ON_THE_WAY: 'On the way',
  DELIVERED: 'Delivered',
  REJECTED: 'Rejected by restaurant',
  CANCELLED: 'Cancelled',
};
export const LIFECYCLE = ['PLACED', 'ACCEPTED', 'IN_KITCHEN', 'PICKED_UP', 'ON_THE_WAY', 'DELIVERED'];
export const TERMINAL = ['DELIVERED', 'REJECTED', 'CANCELLED'];

export const PAYMENT_LABEL = {
  mtn_momo: 'MTN MoMo',
  airtel_money: 'Airtel Money',
  card: 'Card',
  cash: 'Cash',
};

// ---------- geo ----------
export const KAMPALA = { lat: 0.3136, lng: 32.5811, label: 'Kampala Road, Central Division' };

export function haversineKm(a, b) {
  const r = (d) => (d * Math.PI) / 180;
  const dLat = r(b.lat - a.lat);
  const dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export function bearing(a, b) {
  const r = (d) => (d * Math.PI) / 180;
  const y = Math.sin(r(b.lng - a.lng)) * Math.cos(r(b.lat));
  const x = Math.cos(r(a.lat)) * Math.sin(r(b.lat)) - Math.sin(r(a.lat)) * Math.cos(r(b.lat)) * Math.cos(r(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function currentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Location is not available in this browser'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      (e) => reject(new Error(e.code === 1 ? 'Location permission denied' : 'Could not get your location')),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  });
}

// Short beep for new-order / new-dispatch alerts.
export function chime() {
  try {
    const ctx = new AudioContext();
    [0, 0.18].forEach((t, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = i ? 1175 : 880;
      gain.gain.setValueAtTime(0.15, ctx.currentTime + t);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + t);
      osc.stop(ctx.currentTime + t + 0.17);
    });
  } catch {
    /* autoplay blocked */
  }
}

export const PAYMENT_STATUS_LABEL = {
  pending: 'payment pending',
  paid: 'paid',
  cod: 'cash due on delivery',
  failed: 'payment failed',
  refunded: 'refunded',
  refund_pending: 'refund in progress',
};
