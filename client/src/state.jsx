import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, closeSocket, store, KAMPALA } from './lib.js';

// ---------- auth ----------
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => store.get('user'));
  const [ready, setReady] = useState(!store.get('token'));

  useEffect(() => {
    if (!store.get('token')) return;
    api('/auth/me')
      .then(({ user }) => {
        setUser(user);
        store.set('user', user);
      })
      .catch((err) => {
        if (err.status === 401) {
          store.set('token', null);
          store.set('user', null);
          setUser(null);
        }
      })
      .finally(() => setReady(true));
  }, []);

  const signIn = useCallback(({ token, user }) => {
    closeSocket();
    store.set('token', token);
    store.set('user', user);
    setUser(user);
  }, []);

  const signOut = useCallback(() => {
    closeSocket();
    store.set('token', null);
    store.set('user', null);
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, ready, signIn, signOut }), [user, ready, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
export const useAuth = () => useContext(AuthContext);

// ---------- delivery location ----------
const LocationContext = createContext(null);

export function LocationProvider({ children }) {
  const [location, setLocationState] = useState(() => store.get('deliveryLocation', KAMPALA));
  const setLocation = useCallback((loc) => {
    setLocationState(loc);
    store.set('deliveryLocation', loc);
  }, []);
  const value = useMemo(() => ({ location, setLocation }), [location, setLocation]);
  return <LocationContext.Provider value={value}>{children}</LocationContext.Provider>;
}
export const useDeliveryLocation = () => useContext(LocationContext);

// ---------- cart (single restaurant) ----------
const CartContext = createContext(null);
const EMPTY_CART = { restaurant: null, lines: [] };

// Line identity = item + chosen options, so "Rolex + egg" and "Rolex + avo" stay separate.
const lineKey = (menuItemId, selections) =>
  `${menuItemId}:${Object.keys(selections).sort().map((g) => `${g}=${[...selections[g]].sort().join('+')}`).join('|')}`;

export function CartProvider({ children }) {
  const [cart, setCart] = useState(() => store.get('cart', EMPTY_CART));
  useEffect(() => store.set('cart', cart), [cart]);

  const add = useCallback((restaurant, item, selections, quantity, unitPrice, summary) => {
    setCart((c) => {
      const base = c.restaurant?.id === restaurant.id ? c : { restaurant: { id: restaurant.id, name: restaurant.name, emoji: restaurant.emoji }, lines: [] };
      const key = lineKey(item.id, selections);
      const existing = base.lines.find((l) => l.key === key);
      const lines = existing
        ? base.lines.map((l) => (l.key === key ? { ...l, quantity: Math.min(50, l.quantity + quantity) } : l))
        : [...base.lines, { key, menuItemId: item.id, name: item.name, selections, quantity, unitPrice, summary }];
      return { ...base, lines };
    });
  }, []);

  const setQuantity = useCallback((key, quantity) => {
    setCart((c) => {
      const lines = quantity <= 0 ? c.lines.filter((l) => l.key !== key) : c.lines.map((l) => (l.key === key ? { ...l, quantity } : l));
      return lines.length ? { ...c, lines } : EMPTY_CART;
    });
  }, []);

  const clear = useCallback(() => setCart(EMPTY_CART), []);

  const value = useMemo(() => {
    const count = cart.lines.reduce((n, l) => n + l.quantity, 0);
    const subtotal = cart.lines.reduce((n, l) => n + l.quantity * l.unitPrice, 0);
    return { cart, count, subtotal, add, setQuantity, clear };
  }, [cart, add, setQuantity, clear]);
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}
export const useCart = () => useContext(CartContext);

// ---------- socket subscription helper ----------
export function useSocketEvent(socket, event, handler) {
  useEffect(() => {
    if (!socket) return;
    socket.on(event, handler);
    return () => socket.off(event, handler);
  }, [socket, event, handler]);
}
