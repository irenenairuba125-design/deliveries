import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, getSocket, chime, clock, haversineKm, km, ugx, PAYMENT_LABEL, PAYMENT_STATUS_LABEL, TERMINAL } from '../../lib.js';
import { useSocketEvent } from '../../state.jsx';
import { Empty, OrderLines, StatusBadge, useCountdown } from '../../components/common.jsx';
import LiveMap from '../../components/LiveMap.jsx';
import { RestaurantSwitcher, useMerchantRestaurant } from './useMerchantRestaurant.jsx';

const COLUMNS = [
  { title: 'New', statuses: ['PLACED'] },
  { title: 'Preparing', statuses: ['ACCEPTED', 'IN_KITCHEN'] },
  { title: 'Out for delivery', statuses: ['PICKED_UP', 'ON_THE_WAY'] },
];

export default function MerchantOrders() {
  const { restaurants, restaurant, setSelectedId, updateRestaurant, error } = useMerchantRestaurant();
  const [orders, setOrders] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const socket = getSocket();
  const rid = restaurant?.id;

  useEffect(() => {
    if (!rid) return;
    api(`/orders?restaurantId=${rid}`).then((d) => setOrders(d.orders), () => {});
  }, [rid]);

  const loadDrivers = useCallback(() => {
    if (rid) api(`/merchant/restaurants/${rid}/drivers`).then((d) => setDrivers(d.drivers), () => {});
  }, [rid]);
  useEffect(() => {
    loadDrivers();
    const t = setInterval(loadDrivers, 10_000);
    return () => clearInterval(t);
  }, [loadDrivers]);

  useSocketEvent(socket, 'order:update', useCallback((o) => {
    if (o.restaurant.id !== rid || o.status === 'PENDING_PAYMENT') return;
    setOrders((list) => {
      const exists = list.some((x) => x.id === o.id);
      if (!exists && o.status === 'PLACED') chime();
      return exists ? list.map((x) => (x.id === o.id ? o : x)) : [o, ...list];
    });
    loadDrivers();
  }, [rid, loadDrivers]));

  const replace = (o) => setOrders((list) => list.map((x) => (x.id === o.id ? o : x)));

  const active = orders.filter((o) => !TERMINAL.includes(o.status) && o.status !== 'PENDING_PAYMENT');
  const past = orders.filter((o) => TERMINAL.includes(o.status)).slice(0, 8);

  const markers = useMemo(() => [
    restaurant && { id: 'r', kind: 'restaurant', emoji: restaurant.emoji, lat: restaurant.lat, lng: restaurant.lng },
    ...drivers.map((d) => ({ id: `d${d.id}`, kind: 'driver', lat: d.lat, lng: d.lng, popup: `${d.name}${d.busy ? ' (busy)' : ''}` })),
    ...active.map((o) => ({ id: `o${o.id}`, kind: 'home', lat: o.delivery.lat, lng: o.delivery.lng, popup: `Order #${o.id}` })),
  ].filter(Boolean), [restaurant, drivers, active]);

  if (error) return <div className="page"><p className="error">{error}</p></div>;
  if (!restaurants) return <div className="page-loading">Loading…</div>;
  if (!restaurant) return <div className="page"><Empty title="You don't have a restaurant yet" /></div>;

  async function toggleOpen() {
    const { restaurant: r } = await api(`/merchant/restaurants/${rid}`, { method: 'PATCH', body: { isOpen: !restaurant.isOpen } });
    updateRestaurant(r);
  }

  return (
    <div className="page wide">
      <div className="row between wrap">
        <div className="row">
          <h1>{restaurant.emoji} {restaurant.name}</h1>
          <RestaurantSwitcher restaurants={restaurants} restaurant={restaurant} onChange={setSelectedId} />
        </div>
        <label className="switch">
          <input type="checkbox" checked={restaurant.isOpen} onChange={toggleOpen} />
          <span>{restaurant.isOpen ? 'Open for orders' : 'Closed'}</span>
        </label>
      </div>

      <div className="board">
        {COLUMNS.map((col) => {
          const list = active.filter((o) => col.statuses.includes(o.status));
          return (
            <section key={col.title} className="board-col">
              <h2>{col.title} <span className="count-pill">{list.length}</span></h2>
              {list.length === 0 && <p className="muted small">Nothing here</p>}
              {list.map((o) => (
                <MerchantOrderCard key={o.id} order={o} restaurant={restaurant} drivers={drivers} onChange={replace} />
              ))}
            </section>
          );
        })}
        <section className="board-col">
          <h2>Riders nearby <span className="count-pill">{drivers.filter((d) => !d.busy).length} free</span></h2>
          <LiveMap className="merchant-map" center={restaurant} zoom={13} markers={markers} fitKey={`${rid}|${drivers.length}|${active.length}`} />
          <ul className="driver-list small">
            {drivers.map((d) => (
              <li key={d.id}>🛵 {d.name} · {km(d.distance_km)} {d.busy ? <span className="badge">busy</span> : <span className="badge ok">free</span>}</li>
            ))}
            {drivers.length === 0 && <li className="muted">No riders online within 15 km</li>}
          </ul>
          {past.length > 0 && (
            <>
              <h2>Recent</h2>
              <ul className="past-list small">
                {past.map((o) => (
                  <li key={o.id}>#{o.id} · {clock(o.updatedAt)} · {ugx(o.total)} <StatusBadge status={o.status} /></li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function MerchantOrderCard({ order: o, restaurant, drivers, onChange }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [pick, setPick] = useState('');
  const offerLeft = useCountdown(o.driver?.offerStatus === 'offered' && o.driver.offeredAt
    ? new Date(Date.parse(o.driver.offeredAt) + 45_000).toISOString() : null);

  async function run(fn) {
    setBusy(true);
    setErr('');
    try {
      onChange((await fn()).order);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }
  const move = (status, note) => run(() => api(`/orders/${o.id}/status`, { method: 'POST', body: { status, note } }));
  const assign = (driverId) => run(() => api(`/orders/${o.id}/assign`, { method: 'POST', body: { driverId } }));
  const reject = () => {
    const reason = window.prompt('Reason for rejecting (shown to the customer):', 'Sorry, we are too busy right now');
    if (reason !== null) move('REJECTED', reason);
  };

  const canDispatch = (o.status === 'ACCEPTED' || o.status === 'IN_KITCHEN') && o.driver?.offerStatus !== 'accepted';
  const freeDrivers = drivers.filter((d) => !d.busy);
  const distance = haversineKm(restaurant, o.delivery);

  return (
    <article className={`card order-card ${o.status === 'PLACED' ? 'new' : ''}`}>
      <header className="row between">
        <strong>#{o.id}</strong>
        <span className="muted small">{clock(o.createdAt)}</span>
      </header>
      <StatusBadge status={o.status} />
      <OrderLines items={o.items} />
      {o.delivery.notes && <p className="small note">“{o.delivery.notes}”</p>}
      <p className="small muted">
        {o.customer.name} · {km(distance)} · {PAYMENT_LABEL[o.payment.method]} ({o.payment.status === 'cod' ? 'collect cash' : PAYMENT_STATUS_LABEL[o.payment.status] ?? o.payment.status}) · <strong>{ugx(o.total)}</strong>
      </p>

      {o.driver && (
        <p className="small">
          🛵 {o.driver.name} — {o.driver.offerStatus === 'accepted' ? 'assigned' : `waiting for response (${offerLeft}s)`}
        </p>
      )}

      {canDispatch && (
        <div className="dispatch">
          <button className="btn outline small" disabled={busy || !freeDrivers.length} onClick={() => assign(null)}>
            {o.driver ? 'Re-offer to nearest' : 'Auto-assign nearest rider'}
          </button>
          <div className="row">
            <select value={pick} onChange={(e) => setPick(e.target.value)} disabled={!freeDrivers.length} aria-label="Choose rider">
              <option value="">{freeDrivers.length ? 'Choose rider…' : 'No free riders'}</option>
              {freeDrivers.map((d) => <option key={d.id} value={d.id}>{d.name} · {km(d.distance_km)}</option>)}
            </select>
            <button className="btn outline small" disabled={busy || !pick} onClick={() => assign(Number(pick))}>Offer</button>
          </div>
        </div>
      )}

      {err && <p className="error small">{err}</p>}
      <div className="actions">
        {o.status === 'PLACED' && (
          <>
            <button className="btn primary" disabled={busy} onClick={() => move('ACCEPTED')}>Accept</button>
            <button className="btn outline danger" disabled={busy} onClick={reject}>Reject</button>
          </>
        )}
        {o.status === 'ACCEPTED' && <button className="btn primary" disabled={busy} onClick={() => move('IN_KITCHEN')}>Start cooking</button>}
        {o.status === 'IN_KITCHEN' && <span className="muted small">Hand over when the rider arrives — they'll mark it picked up.</span>}
      </div>
    </article>
  );
}
