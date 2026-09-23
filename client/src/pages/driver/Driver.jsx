import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, getSocket, bearing, chime, clock, currentPosition, haversineKm, km, minutes, store, ugx, PAYMENT_LABEL, TERMINAL } from '../../lib.js';
import { useAuth, useSocketEvent } from '../../state.jsx';
import { OrderLines, StatusBadge, useCountdown } from '../../components/common.jsx';
import LiveMap from '../../components/LiveMap.jsx';

const OFFER_MS = 45_000;
const SIM_SPEED_KMH = 30;
const ACTION = {
  PICKED_UP: { label: 'Picked up the order', icon: '📦' },
  ON_THE_WAY: { label: 'Start delivery', icon: '🛵' },
  DELIVERED: { label: 'Mark as delivered', icon: '✅' },
};

const isMine = (o, uid) => o.driver?.id === uid && !TERMINAL.includes(o.status);
const targetOf = (job) =>
  job && (job.status === 'PICKED_UP' || job.status === 'ON_THE_WAY')
    ? { ...job.delivery, name: 'Customer', kind: 'to_customer' }
    : job && { lat: job.restaurant.lat, lng: job.restaurant.lng, name: job.restaurant.name, kind: 'to_restaurant' };

export default function Driver() {
  const { user } = useAuth();
  const socket = getSocket();
  const [online, setOnline] = useState(false);
  const [mode, setModeState] = useState(() => store.get('driverMode', 'sim'));
  const [pos, setPos] = useState(null);
  const [offer, setOffer] = useState(null);
  const [job, setJob] = useState(null);
  const [history, setHistory] = useState([]);
  const [route, setRoute] = useState(null);
  const [simulating, setSimulating] = useState(false);
  const [simSpeed, setSimSpeed] = useState(5);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const posRef = useRef(null);

  const setMode = (m) => {
    setModeState(m);
    store.set('driverMode', m);
  };

  // Send a location fix to the server (which fans it out to customers tracking our orders).
  const publish = useCallback((p) => {
    posRef.current = p;
    setPos(p);
    socket?.emit('driver:location', p);
  }, [socket]);

  // ---------- initial load ----------
  useEffect(() => {
    api('/driver/me').then(({ driver }) => {
      setOnline(driver.isOnline);
      if (driver.lat != null) {
        posRef.current = { lat: driver.lat, lng: driver.lng, heading: 0 };
        setPos(posRef.current);
      }
    }, (e) => setError(e.message));
    api('/orders').then(({ orders }) => {
      const mine = orders.filter((o) => isMine(o, user.id));
      setJob(mine.find((o) => o.driver.offerStatus === 'accepted') ?? null);
      const offered = mine.find((o) => o.driver.offerStatus === 'offered');
      if (offered) setOffer({ order: offered, expiresAt: new Date(Date.parse(offered.driver.offeredAt) + OFFER_MS).toISOString() });
      setHistory(orders.filter((o) => o.status === 'DELIVERED').slice(0, 10));
    }, () => {});
  }, [user.id]);

  // ---------- realtime ----------
  useSocketEvent(socket, 'dispatch:offer', useCallback((payload) => {
    chime();
    setOffer(payload);
  }, []));

  useSocketEvent(socket, 'order:update', useCallback((o) => {
    setOffer((cur) => (cur?.order.id === o.id && !(isMine(o, user.id) && o.driver.offerStatus === 'offered') ? null : cur));
    setJob((cur) => {
      if (isMine(o, user.id) && o.driver.offerStatus === 'accepted') return { ...o, allowedNext: nextFor(o.status) };
      return cur?.id === o.id ? null : cur;
    });
    if (o.status === 'DELIVERED' && o.driver?.id === user.id) {
      setHistory((h) => [o, ...h.filter((x) => x.id !== o.id)].slice(0, 10));
    }
  }, [user.id]));

  // ---------- real GPS ----------
  useEffect(() => {
    if (!online || mode !== 'gps' || !navigator.geolocation) return;
    let last = posRef.current;
    const id = navigator.geolocation.watchPosition(
      (p) => {
        const next = { lat: p.coords.latitude, lng: p.coords.longitude };
        const heading = Number.isFinite(p.coords.heading) ? p.coords.heading : last ? bearing(last, next) : 0;
        last = next;
        publish({ ...next, heading, speed: p.coords.speed });
      },
      (e) => setError(e.code === 1 ? 'Location permission denied — switch to simulated GPS or allow location.' : 'GPS signal lost'),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [online, mode, publish]);

  // ---------- route to current target ----------
  const target = targetOf(job);
  const targetKey = target && `${target.kind}:${target.lat},${target.lng}`;
  const fetchRoute = useCallback(async () => {
    const from = posRef.current;
    if (!target || !from) return setRoute(null);
    try {
      const { route } = await api(`/geo/route?fromLat=${from.lat}&fromLng=${from.lng}&toLat=${target.lat}&toLng=${target.lng}`);
      setRoute({ ...route, kind: target.kind });
    } catch {
      /* keep the previous route */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

  useEffect(() => {
    setSimulating(false);
    fetchRoute();
  }, [fetchRoute]);

  useEffect(() => {
    if (mode !== 'gps' || !target) return;
    const t = setInterval(fetchRoute, 20_000);
    return () => clearInterval(t);
  }, [mode, target, fetchRoute]);

  // ---------- simulated driving along the route ----------
  useEffect(() => {
    if (!simulating || !route?.coordinates?.length) return;
    const path = route.coordinates.map(([lat, lng]) => ({ lat, lng }));
    let seg = 0;
    let along = 0; // km travelled within current segment
    const stepKm = (SIM_SPEED_KMH * simSpeed) / 3600; // per 1 s tick
    const t = setInterval(() => {
      let remaining = stepKm;
      while (seg < path.length - 1) {
        const segLen = haversineKm(path[seg], path[seg + 1]);
        if (along + remaining < segLen) {
          along += remaining;
          break;
        }
        remaining -= segLen - along;
        along = 0;
        seg += 1;
      }
      if (seg >= path.length - 1) {
        publish({ ...path.at(-1), heading: posRef.current?.heading ?? 0, speed: 0 });
        setSimulating(false);
        return;
      }
      const a = path[seg];
      const b = path[seg + 1];
      const f = along / (haversineKm(a, b) || 1);
      publish({ lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f, heading: bearing(a, b), speed: (SIM_SPEED_KMH * simSpeed) / 3.6 });
    }, 1000);
    return () => clearInterval(t);
  }, [simulating, route, simSpeed, publish]);

  // ---------- actions ----------
  async function toggleOnline() {
    setBusy(true);
    setError('');
    try {
      let p = posRef.current;
      if (!online && mode === 'gps') p = await currentPosition();
      if (!online && !p) throw new Error('No starting location — switch to GPS mode');
      await api('/driver/status', { method: 'POST', body: { online: !online, lat: p?.lat, lng: p?.lng } });
      if (!online && p) publish({ ...p, heading: p.heading ?? 0 });
      setOnline(!online);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function respond(accept) {
    setBusy(true);
    setError('');
    try {
      const { order } = await api(`/orders/${offer.order.id}/offer-response`, { method: 'POST', body: { accept } });
      if (order) setJob(order);
      setOffer(null);
    } catch (e) {
      setError(e.message);
      setOffer(null);
    } finally {
      setBusy(false);
    }
  }

  async function advance(status) {
    if (status === 'DELIVERED' && job.payment.method === 'cash' &&
        !window.confirm(`Collect ${ugx(job.total)} in cash from the customer before confirming.`)) return;
    setBusy(true);
    setError('');
    try {
      const { order } = await api(`/orders/${job.id}/status`, { method: 'POST', body: { status } });
      setJob(TERMINAL.includes(order.status) ? null : order);
      if (order.status === 'DELIVERED') setHistory((h) => [order, ...h.filter((x) => x.id !== order.id)]);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  // ---------- map ----------
  const markers = useMemo(() => {
    const shown = job ?? offer?.order;
    return [
      pos && { id: 'me', kind: 'driver', ...pos },
      shown && { id: 'r', kind: 'restaurant', emoji: shown.restaurant.emoji, lat: shown.restaurant.lat, lng: shown.restaurant.lng, popup: shown.restaurant.name },
      shown && { id: 'c', kind: 'home', lat: shown.delivery.lat, lng: shown.delivery.lng, popup: shown.delivery.address },
    ].filter(Boolean);
  }, [pos, job, offer]);
  const routes = useMemo(() => (route && job ? [{ id: 'nav', kind: route.kind, coordinates: route.coordinates }] : []), [route, job]);

  const remainingKm = target && pos ? haversineKm(pos, target) : null;

  return (
    <div className="driver-page">
      <div className="driver-map-wrap">
        <LiveMap className="driver-map" center={pos ?? { lat: 0.3136, lng: 32.5811 }} zoom={14} markers={markers} routes={routes}
          fitKey={`${job?.id}|${job?.status}|${offer?.order.id}|${Boolean(pos)}`} />
        <div className="driver-status-bar">
          <button className={`btn ${online ? 'success' : 'outline'}`} onClick={toggleOnline} disabled={busy || (online && Boolean(job))}>
            {online ? '● Online' : 'Go online'}
          </button>
          <select value={mode} onChange={(e) => setMode(e.target.value)} disabled={online} aria-label="Location source">
            <option value="sim">Simulated GPS (demo)</option>
            <option value="gps">Device GPS</option>
          </select>
        </div>
      </div>

      <div className="driver-panel stack">
        {error && <p className="error">{error}</p>}

        {offer && !job && <OfferCard offer={offer} pos={pos} busy={busy} onRespond={respond} />}

        {job ? (
          <div className="card">
            <div className="row between">
              <h2>Order #{job.id}</h2>
              <StatusBadge status={job.status} />
            </div>
            <div className="nav-target">
              <div className="small muted">{target.kind === 'to_restaurant' ? 'Pick up from' : 'Deliver to'}</div>
              <strong>{target.kind === 'to_restaurant' ? `${job.restaurant.emoji} ${job.restaurant.name}` : job.customer.name}</strong>
              <div className="small">{target.kind === 'to_restaurant' ? job.restaurant.address : job.delivery.address}</div>
              {job.delivery.notes && target.kind === 'to_customer' && <div className="small note">“{job.delivery.notes}”</div>}
              {route && (
                <div className="small">
                  {km(remainingKm ?? route.distanceKm)} straight line · route {km(route.distanceKm)} · ~{minutes(route.durationSec)}
                </div>
              )}
            </div>
            <div className="row wrap">
              <a className="btn outline small" target="_blank" rel="noreferrer"
                href={`https://www.google.com/maps/dir/?api=1&destination=${target.lat},${target.lng}&travelmode=driving`}>
                🧭 Navigate
              </a>
              {target.kind === 'to_customer' && job.customer.phone && (
                <a className="btn outline small" href={`tel:${job.customer.phone}`}>📞 Call customer</a>
              )}
              {mode === 'sim' && (
                <>
                  <button className={`btn small ${simulating ? 'success' : 'outline'}`} onClick={() => setSimulating((s) => !s)} disabled={!route}>
                    {simulating ? '⏸ Stop driving' : '▶ Simulate drive'}
                  </button>
                  <select value={simSpeed} onChange={(e) => setSimSpeed(Number(e.target.value))} aria-label="Simulation speed">
                    {[1, 5, 10, 25].map((s) => <option key={s} value={s}>{s}× speed</option>)}
                  </select>
                </>
              )}
            </div>

            <div className="actions">
              {job.status === 'ACCEPTED' && <p className="muted small">Head to the restaurant. You can pick up once they start cooking.</p>}
              {(job.allowedNext ?? []).map((s) => (
                <button key={s} className="btn primary block big" disabled={busy} onClick={() => advance(s)}>
                  {ACTION[s]?.icon} {ACTION[s]?.label ?? s}
                </button>
              ))}
            </div>

            <details>
              <summary className="small">Order details · {ugx(job.total)} · {PAYMENT_LABEL[job.payment.method]}{job.payment.method === 'cash' ? ' (collect cash)' : ''}</summary>
              <OrderLines items={job.items} />
            </details>
          </div>
        ) : (
          !offer && (
            <div className="card center">
              <div className="empty-icon">{online ? '📡' : '😴'}</div>
              <h2>{online ? 'Waiting for orders…' : "You're offline"}</h2>
              <p className="muted small">
                {online
                  ? 'Restaurants nearby can now send you delivery requests.'
                  : 'Go online to start receiving delivery requests.'}
              </p>
            </div>
          )
        )}

        {history.length > 0 && (
          <div className="card">
            <h2>Recent deliveries</h2>
            <ul className="past-list small">
              {history.map((o) => (
                <li key={o.id}>#{o.id} · {o.restaurant.name} · {clock(o.updatedAt)} · {ugx(o.deliveryFee)} fee</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function OfferCard({ offer, pos, busy, onRespond }) {
  const left = useCountdown(offer.expiresAt);
  const o = offer.order;
  const toRestaurant = pos ? haversineKm(pos, o.restaurant) : offer.distanceToRestaurantKm;
  const trip = haversineKm(o.restaurant, o.delivery);
  return (
    <div className="card offer-card">
      <div className="row between">
        <h2>New delivery request</h2>
        <span className={`countdown ${left < 10 ? 'urgent' : ''}`}>{left}s</span>
      </div>
      <p><strong>{o.restaurant.emoji} {o.restaurant.name}</strong> → {o.delivery.address}</p>
      <p className="small muted">
        {toRestaurant != null && `${km(toRestaurant)} to pickup · `}{km(trip)} delivery · earn {ugx(o.deliveryFee)}
        {o.payment.method === 'cash' && ` · collect ${ugx(o.total)} cash`}
      </p>
      <div className="row">
        <button className="btn outline grow" disabled={busy} onClick={() => onRespond(false)}>Decline</button>
        <button className="btn primary grow" disabled={busy || left === 0} onClick={() => onRespond(true)}>Accept</button>
      </div>
    </div>
  );
}

// Driver-side transitions (mirrors the server state machine).
function nextFor(status) {
  return { IN_KITCHEN: ['PICKED_UP'], PICKED_UP: ['ON_THE_WAY'], ON_THE_WAY: ['DELIVERED'] }[status] ?? [];
}
