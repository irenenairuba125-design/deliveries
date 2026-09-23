import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, getSocket, clock, ugx } from '../../lib.js';
import { useSocketEvent } from '../../state.jsx';
import { Empty, StatusBadge } from '../../components/common.jsx';

export default function Orders() {
  const [orders, setOrders] = useState(null);
  const [error, setError] = useState('');
  const socket = getSocket();

  useEffect(() => {
    api('/orders').then((d) => setOrders(d.orders), (e) => setError(e.message));
  }, []);

  useSocketEvent(socket, 'order:update', useCallback((o) => {
    setOrders((list) => list?.map((x) => (x.id === o.id ? { ...x, ...o } : x)));
  }, []));

  if (error) return <div className="page"><p className="error">{error}</p></div>;
  if (!orders) return <div className="page-loading">Loading…</div>;

  return (
    <div className="page narrow">
      <h1>Your orders</h1>
      {orders.length === 0 && (
        <Empty icon="🧾" title="No orders yet"><Link to="/" className="btn primary">Browse restaurants</Link></Empty>
      )}
      <div className="stack">
        {orders.map((o) => (
          <Link key={o.id} to={`/orders/${o.id}`} className="card order-row">
            <span className="restaurant-emoji">{o.restaurant.emoji}</span>
            <div className="grow">
              <strong>{o.restaurant.name}</strong>
              <div className="muted small">
                #{o.id} · {new Date(o.createdAt).toLocaleDateString()} {clock(o.createdAt)} · {o.items.reduce((n, i) => n + i.quantity, 0)} items
              </div>
            </div>
            <div className="right">
              <StatusBadge status={o.status} />
              <div className="small">{ugx(o.total)}</div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
