// Order lifecycle:
// PENDING_PAYMENT -> PLACED -> ACCEPTED -> IN_KITCHEN -> PICKED_UP -> ON_THE_WAY -> DELIVERED
// with REJECTED / CANCELLED as terminal side exits.

export const STATUS = Object.freeze({
  PENDING_PAYMENT: 'PENDING_PAYMENT',
  PLACED: 'PLACED',
  ACCEPTED: 'ACCEPTED',
  IN_KITCHEN: 'IN_KITCHEN',
  PICKED_UP: 'PICKED_UP',
  ON_THE_WAY: 'ON_THE_WAY',
  DELIVERED: 'DELIVERED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
});

// from -> { to: [roles allowed to make that move] }
const TRANSITIONS = {
  PENDING_PAYMENT: { PLACED: ['system'], CANCELLED: ['customer', 'system'] },
  PLACED: { ACCEPTED: ['merchant'], REJECTED: ['merchant'], CANCELLED: ['customer', 'merchant'] },
  ACCEPTED: { IN_KITCHEN: ['merchant'], CANCELLED: ['merchant'] },
  IN_KITCHEN: { PICKED_UP: ['driver'], CANCELLED: ['merchant'] },
  PICKED_UP: { ON_THE_WAY: ['driver'] },
  ON_THE_WAY: { DELIVERED: ['driver'] },
};

export const TERMINAL = new Set([STATUS.DELIVERED, STATUS.REJECTED, STATUS.CANCELLED]);
export const ACTIVE_DRIVER_STATUSES = [STATUS.ACCEPTED, STATUS.IN_KITCHEN, STATUS.PICKED_UP, STATUS.ON_THE_WAY];
export const DISPATCHABLE = new Set([STATUS.ACCEPTED, STATUS.IN_KITCHEN]);

export function canTransition(from, to, role) {
  return TRANSITIONS[from]?.[to]?.includes(role) ?? false;
}

export function allowedNext(from, role) {
  return Object.entries(TRANSITIONS[from] ?? {})
    .filter(([, roles]) => roles.includes(role))
    .map(([to]) => to);
}
