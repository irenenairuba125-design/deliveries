import { useEffect, useRef, useState } from 'react';
import { api, currentPosition, clock, ugx, STATUS_LABEL, LIFECYCLE } from '../lib.js';

// ---------- address autocomplete ----------
export function AddressPicker({ value, onChange, placeholder = 'Search for a street, building or area' }) {
  const [text, setText] = useState(value?.label ?? '');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const reqId = useRef(0);

  useEffect(() => setText(value?.label ?? ''), [value?.label]);

  useEffect(() => {
    if (!open || text.trim().length < 2 || text === value?.label) {
      setResults([]);
      return;
    }
    const id = ++reqId.current;
    const t = setTimeout(async () => {
      try {
        const { results } = await api(`/geo/autocomplete?q=${encodeURIComponent(text)}`);
        if (id === reqId.current) setResults(results);
      } catch {
        if (id === reqId.current) setResults([]);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [text, open, value?.label]);

  async function useGps() {
    setBusy(true);
    setError('');
    try {
      const pos = await currentPosition();
      onChange({ ...pos, label: `My location (${pos.lat.toFixed(4)}, ${pos.lng.toFixed(4)})` });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="address-picker">
      <div className="row">
        <input
          value={text}
          placeholder={placeholder}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          aria-label="Delivery address"
        />
        <button type="button" className="btn ghost" onClick={useGps} disabled={busy} title="Use my current location">
          {busy ? '…' : '📍'}
        </button>
      </div>
      {open && results.length > 0 && (
        <ul className="suggestions">
          {results.map((r) => (
            <li key={`${r.lat},${r.lng},${r.label}`}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(r);
                  setOpen(false);
                }}
              >
                {r.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

// ---------- order status timeline ----------
export function StatusTimeline({ order }) {
  const when = Object.fromEntries(order.events.map((e) => [e.status, e.createdAt]));
  if (order.status === 'REJECTED' || order.status === 'CANCELLED') {
    const ev = [...order.events].reverse().find((e) => e.status === order.status);
    return (
      <div className="timeline-stopped">
        <strong>{STATUS_LABEL[order.status]}</strong>
        {ev?.note && <span> — {ev.note}</span>}
        {order.payment.status === 'refunded' && <p className="muted small">Your payment of {ugx(order.total)} has been refunded.</p>}
        {order.payment.status === 'refund_pending' && (
          <p className="muted small">Your refund of {ugx(order.total)} is being processed and should reach you within 1–3 days.</p>
        )}
      </div>
    );
  }
  const current = LIFECYCLE.indexOf(order.status);
  return (
    <ol className="timeline">
      {LIFECYCLE.map((s, i) => (
        <li key={s} className={i < current ? 'done' : i === current ? 'current' : ''}>
          <span className="dot" />
          <span className="label">{STATUS_LABEL[s]}</span>
          {when[s] && <span className="time">{clock(when[s])}</span>}
        </li>
      ))}
    </ol>
  );
}

export function StatusBadge({ status }) {
  return <span className={`badge status-${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function OrderLines({ items }) {
  return (
    <ul className="order-lines">
      {items.map((i) => (
        <li key={i.id}>
          <span>
            <strong>{i.quantity}×</strong> {i.name}
            {i.modifiers.length > 0 && <span className="muted small"> · {i.modifiers.map((m) => m.option).join(', ')}</span>}
          </span>
          <span>{ugx(i.lineTotal)}</span>
        </li>
      ))}
    </ul>
  );
}

export function Empty({ icon = '🍽️', title, children }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      {children}
    </div>
  );
}

// Counts down to an ISO timestamp.
export function useCountdown(iso) {
  const [left, setLeft] = useState(() => (iso ? Math.max(0, Date.parse(iso) - Date.now()) : 0));
  useEffect(() => {
    if (!iso) return;
    const tick = () => setLeft(Math.max(0, Date.parse(iso) - Date.now()));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [iso]);
  return Math.ceil(left / 1000);
}
