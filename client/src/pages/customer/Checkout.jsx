import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, km, ugx } from '../../lib.js';
import { useAuth, useCart, useDeliveryLocation } from '../../state.jsx';
import { AddressPicker, Empty } from '../../components/common.jsx';
import LiveMap from '../../components/LiveMap.jsx';

// Presentation for each method; which ones are offered (and live vs test) comes from the server.
const METHOD_UI = {
  mtn_momo: { icon: '🟡', hint: 'MTN numbers start 076/077/078/079. You will get a PIN prompt on your phone.' },
  airtel_money: { icon: '🔴', hint: 'Airtel numbers start 070/074/075. You will get a PIN prompt on your phone.' },
  card: { icon: '💳', hint: 'Visa, Mastercard and more, processed securely by Stripe.' },
  cash: { icon: '💵', hint: 'Pay the rider when your food arrives.' },
};
const MODE_TAG = { test: 'test mode', sandbox: 'simulated' };

export default function Checkout() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { cart, count, subtotal, setQuantity, clear } = useCart();
  const { location, setLocation } = useDeliveryLocation();
  const [address, setAddress] = useState(location);
  const [notes, setNotes] = useState('');
  const [methods, setMethods] = useState(null);
  const [method, setMethod] = useState(null);
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [quote, setQuote] = useState(null);
  const [quoteError, setQuoteError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [restaurant, setRestaurant] = useState(null);

  useEffect(() => {
    api('/payment-methods').then(({ methods }) => {
      setMethods(methods);
      setMethod((m) => m ?? methods[0]?.id ?? null);
    }, (e) => setError(e.message));
  }, []);

  const items = useMemo(
    () => cart.lines.map((l) => ({ menuItemId: l.menuItemId, quantity: l.quantity, selections: l.selections })),
    [cart.lines],
  );

  useEffect(() => {
    if (cart.restaurant) api(`/restaurants/${cart.restaurant.id}`).then((d) => setRestaurant(d.restaurant), () => {});
  }, [cart.restaurant]);

  // Server-side quote: authoritative prices, delivery fee and radius check.
  useEffect(() => {
    if (!user || user.role !== 'customer' || !cart.restaurant || !items.length) return;
    let cancelled = false;
    const t = setTimeout(() => {
      api('/orders/quote', { method: 'POST', body: { restaurantId: cart.restaurant.id, items, lat: address.lat, lng: address.lng } })
        .then((q) => !cancelled && (setQuote(q), setQuoteError('')))
        .catch((e) => !cancelled && (setQuote(null), setQuoteError(e.message)));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [user, cart.restaurant, items, address.lat, address.lng]);

  const markers = useMemo(
    () => [
      { id: 'home', kind: 'home', lat: address.lat, lng: address.lng },
      restaurant && { id: 'r', kind: 'restaurant', emoji: restaurant.emoji, lat: restaurant.lat, lng: restaurant.lng },
    ].filter(Boolean),
    [address.lat, address.lng, restaurant],
  );
  const circles = useMemo(
    () => (restaurant ? [{ id: 'radius', lat: restaurant.lat, lng: restaurant.lng, radiusKm: restaurant.deliveryRadiusKm }] : []),
    [restaurant],
  );

  if (!count) {
    return (
      <div className="page">
        <Empty icon="🛒" title="Your cart is empty"><Link to="/" className="btn primary">Find something tasty</Link></Empty>
      </div>
    );
  }

  const selected = methods?.find((m) => m.id === method) ?? { needsPhone: false };

  async function placeOrder() {
    setBusy(true);
    setError('');
    try {
      const { order, paymentMessage, clientSecret } = await api('/orders', {
        method: 'POST',
        body: {
          restaurantId: cart.restaurant.id, items, lat: address.lat, lng: address.lng,
          address: address.label, notes, paymentMethod: method, phone: selected.needsPhone ? phone : undefined,
        },
      });
      setLocation(address);
      clear();
      navigate(`/orders/${order.id}`, { state: { paymentMessage, clientSecret } });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page with-sidebar">
      <div className="stack">
        <h1>Checkout</h1>
        <section className="card">
          <h2>Delivery address</h2>
          <AddressPicker value={address} onChange={setAddress} />
          <p className="muted small">Tap the map to drop the pin exactly where the rider should come.</p>
          <LiveMap
            className="checkout-map"
            center={address}
            zoom={14}
            markers={markers}
            circles={circles}
            fitKey={`${restaurant?.id}`}
            onClick={(p) => setAddress({ ...p, label: `Pinned location (${p.lat.toFixed(5)}, ${p.lng.toFixed(5)})` })}
          />
          <label>
            Directions for the rider
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} rows={2}
              placeholder="Gate colour, floor, landmark…" />
          </label>
        </section>

        <section className="card">
          <h2>Payment</h2>
          <div className="pay-methods">
            {methods?.map((m) => (
              <label key={m.id} className={`option ${method === m.id ? 'checked' : ''}`}>
                <input type="radio" name="pay" checked={method === m.id} onChange={() => setMethod(m.id)} />
                <span>{METHOD_UI[m.id]?.icon} {m.label}</span>
                {MODE_TAG[m.mode] && <span className="badge">{MODE_TAG[m.mode]}</span>}
              </label>
            ))}
          </div>
          {methods?.length === 0 && <p className="error small">No payment methods are available right now.</p>}
          {selected.needsPhone && (
            <label>
              Mobile money number
              <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0772 123456" inputMode="tel" />
            </label>
          )}
          {METHOD_UI[method]?.hint && <p className="muted small">{METHOD_UI[method].hint}</p>}
        </section>
      </div>

      <aside className="card cart-panel">
        <h2>{cart.restaurant.emoji} {cart.restaurant.name}</h2>
        <ul className="cart-lines">
          {cart.lines.map((l) => (
            <li key={l.key}>
              <div>
                <strong>{l.name}</strong>
                {l.summary && <div className="muted small">{l.summary}</div>}
              </div>
              <div className="stepper small">
                <button onClick={() => setQuantity(l.key, l.quantity - 1)} aria-label="Remove one">−</button>
                <span>{l.quantity}</span>
                <button onClick={() => setQuantity(l.key, Math.min(50, l.quantity + 1))} aria-label="Add one">+</button>
              </div>
            </li>
          ))}
        </ul>
        <div className="total-row"><span>Subtotal</span><span>{ugx(quote?.subtotal ?? subtotal)}</span></div>
        <div className="total-row">
          <span>Delivery{quote && <span className="muted small"> · {km(quote.distanceKm)}</span>}</span>
          <span>{quote ? ugx(quote.deliveryFee) : '–'}</span>
        </div>
        <div className="total-row grand"><span>Total</span><strong>{quote ? ugx(quote.total) : '–'}</strong></div>

        {quote?.outOfRange && <p className="error small">Too far: {cart.restaurant.name} delivers within {quote.deliveryRadiusKm} km.</p>}
        {quote && !quote.isOpen && <p className="error small">{cart.restaurant.name} is closed right now.</p>}
        {quoteError && <p className="error small">{quoteError}</p>}
        {error && <p className="error">{error}</p>}

        {!user ? (
          <Link to="/login" state={{ from: '/checkout' }} className="btn primary block">Sign in to place order</Link>
        ) : user.role !== 'customer' ? (
          <p className="muted">Sign in as a customer to order.</p>
        ) : (
          <button className="btn primary block" onClick={placeOrder}
            disabled={busy || !quote || quote.outOfRange || !quote.isOpen || !method || (selected.needsPhone && !phone.trim())}>
            {busy ? 'Placing order…' : `Place order${quote ? ` · ${ugx(quote.total)}` : ''}`}
          </button>
        )}
      </aside>
    </div>
  );
}
