import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, km, ugx } from '../../lib.js';
import { useCart, useDeliveryLocation } from '../../state.jsx';
import ItemModal from '../../components/ItemModal.jsx';
import { Empty } from '../../components/common.jsx';

export default function Restaurant() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { location } = useDeliveryLocation();
  const { cart, count, subtotal, add, setQuantity } = useCart();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [picking, setPicking] = useState(null);
  const [toast, setToast] = useState('');

  useEffect(() => {
    api(`/restaurants/${id}?lat=${location.lat}&lng=${location.lng}`).then(setData, (e) => setError(e.message));
  }, [id, location.lat, location.lng]);

  const categories = useMemo(() => {
    const map = new Map();
    for (const item of data?.menu ?? []) {
      if (!map.has(item.category)) map.set(item.category, []);
      map.get(item.category).push(item);
    }
    return [...map];
  }, [data]);

  const addToCart = useCallback(
    (item, { selections, quantity, unitPrice, summary }) => {
      const r = data.restaurant;
      if (cart.restaurant && cart.restaurant.id !== r.id &&
          !window.confirm(`Your cart has items from ${cart.restaurant.name}. Start a new cart for ${r.name}?`)) {
        return;
      }
      add(r, item, selections, quantity, unitPrice, summary);
      setPicking(null);
      setToast(`Added ${item.name}`);
      setTimeout(() => setToast(''), 1800);
    },
    [data, cart.restaurant, add],
  );

  if (error) return <div className="page"><Empty icon="😕" title={error}><Link to="/">Back to restaurants</Link></Empty></div>;
  if (!data) return <div className="page-loading">Loading menu…</div>;

  const r = data.restaurant;
  const outOfRange = r.distanceKm != null && r.distanceKm > r.deliveryRadiusKm;
  const cartHere = cart.restaurant?.id === r.id;

  return (
    <div className="page with-sidebar">
      <div>
        <Link to="/" className="back">← All restaurants</Link>
        <header className="restaurant-header">
          <div className="restaurant-emoji big">{r.emoji}</div>
          <div>
            <h1>{r.name}</h1>
            <p className="muted">{r.description}</p>
            <p className="meta small">
              <span>⭐ {r.rating.toFixed(1)}</span>
              <span>{r.cuisine}</span>
              <span>📍 {r.address}</span>
              {r.distanceKm != null && <span>{km(r.distanceKm)} away</span>}
              <span>~{r.prepTimeMin} min prep</span>
            </p>
          </div>
        </header>
        {!r.isOpen && <div className="notice warn">This restaurant is closed right now. You can browse the menu, but you can't order.</div>}
        {outOfRange && <div className="notice warn">Outside delivery area — {r.name} delivers within {r.deliveryRadiusKm} km.</div>}

        {categories.map(([cat, items]) => (
          <section key={cat} className="menu-section">
            <h2>{cat}</h2>
            <div className="menu-grid">
              {items.map((item) => (
                <button
                  key={item.id}
                  className={`card menu-item ${item.available ? '' : 'soldout'}`}
                  disabled={!item.available || !r.isOpen}
                  onClick={() =>
                    item.modifiers.length
                      ? setPicking(item)
                      : addToCart(item, { selections: {}, quantity: 1, unitPrice: item.price, summary: '' })}
                >
                  <div>
                    <h3>{item.name}</h3>
                    <p className="muted small">{item.description}</p>
                    <p className="price">{ugx(item.price)}{item.modifiers.length > 0 && <span className="muted small"> · customisable</span>}</p>
                  </div>
                  <span className="add">{item.available ? '+' : 'Sold out'}</span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>

      <aside className="card cart-panel">
        <h2>Your order</h2>
        {!cartHere || count === 0 ? (
          <p className="muted">{count > 0 ? `Your cart has items from ${cart.restaurant.name}.` : 'Tap a dish to add it.'}</p>
        ) : (
          <>
            <ul className="cart-lines">
              {cart.lines.map((l) => (
                <li key={l.key}>
                  <div>
                    <strong>{l.name}</strong>
                    {l.summary && <div className="muted small">{l.summary}</div>}
                    <div className="small">{ugx(l.unitPrice * l.quantity)}</div>
                  </div>
                  <div className="stepper small">
                    <button onClick={() => setQuantity(l.key, l.quantity - 1)} aria-label="Remove one">−</button>
                    <span>{l.quantity}</span>
                    <button onClick={() => setQuantity(l.key, Math.min(50, l.quantity + 1))} aria-label="Add one">+</button>
                  </div>
                </li>
              ))}
            </ul>
            <div className="total-row"><span>Subtotal</span><strong>{ugx(subtotal)}</strong></div>
            <button className="btn primary block" onClick={() => navigate('/checkout')} disabled={!r.isOpen}>
              Checkout · {count} item{count > 1 ? 's' : ''}
            </button>
          </>
        )}
      </aside>

      {picking && <ItemModal item={picking} onClose={() => setPicking(null)} onAdd={(sel) => addToCart(picking, sel)} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
