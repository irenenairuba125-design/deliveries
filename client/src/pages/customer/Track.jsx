import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { api, getSocket, clock, km, minutes, ugx, PAYMENT_LABEL, PAYMENT_STATUS_LABEL, STATUS_LABEL, TERMINAL } from '../../lib.js';
import { useSocketEvent } from '../../state.jsx';
import { OrderLines, StatusTimeline } from '../../components/common.jsx';
import LiveMap from '../../components/LiveMap.jsx';
import StripePay from '../../components/StripePay.jsx';

const PHASE_TEXT = {
  preparing: 'The restaurant is preparing your food',
  driver_to_restaurant: 'Your rider is heading to the restaurant',
  delivering: 'Your rider is on the way to you',
};

export default function Track() {
  const { id } = useParams();
  const orderId = Number(id);
  const { paymentMessage, clientSecret } = useLocation().state ?? {};
  const socket = getSocket();
  const [order, setOrder] = useState(null);
  const [tracking, setTracking] = useState(null);
  const [driverPos, setDriverPos] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refreshTracking = useCallback(() => {
    api(`/orders/${orderId}/tracking`).then((d) => setTracking(d.tracking), () => {});
  }, [orderId]);

  useEffect(() => {
    api(`/orders/${orderId}`).then(
      ({ order }) => {
        setOrder(order);
        if (order.driver?.lat != null) setDriverPos({ lat: order.driver.lat, lng: order.driver.lng, heading: order.driver.heading });
      },
      (e) => setError(e.message),
    );
    refreshTracking();
  }, [orderId, refreshTracking]);

  // Join the order room now and again after every reconnect.
  useEffect(() => {
    if (!socket) return;
    const join = () => socket.emit('order:subscribe', orderId);
    join();
    socket.on('connect', join);
    return () => {
      socket.off('connect', join);
      socket.emit('order:unsubscribe', orderId);
    };
  }, [socket, orderId]);

  useSocketEvent(socket, 'order:update', useCallback((o) => {
    if (o.id !== orderId) return;
    setOrder({ ...o, allowedNext: cancellable(o.status) });
    if (o.driver?.lat != null) setDriverPos((p) => p ?? { lat: o.driver.lat, lng: o.driver.lng, heading: o.driver.heading });
    refreshTracking();
  }, [orderId, refreshTracking]));

  useSocketEvent(socket, 'order:driver_location', useCallback((p) => {
    if (p.orderId === orderId) setDriverPos({ lat: p.lat, lng: p.lng, heading: p.heading });
  }, [orderId]));

  useSocketEvent(socket, 'order:eta', useCallback((t) => {
    if (t.orderId === orderId) setTracking(t);
  }, [orderId]));

  const showDriver = order?.driver?.offerStatus === 'accepted' && !TERMINAL.includes(order.status);
  const markers = useMemo(() => {
    if (!order) return [];
    return [
      { id: 'r', kind: 'restaurant', emoji: order.restaurant.emoji, lat: order.restaurant.lat, lng: order.restaurant.lng, popup: order.restaurant.name },
      { id: 'home', kind: 'home', lat: order.delivery.lat, lng: order.delivery.lng, popup: 'Delivery address' },
      showDriver && driverPos && { id: 'driver', kind: 'driver', ...driverPos, popup: order.driver.name },
    ].filter(Boolean);
  }, [order, driverPos, showDriver]);

  const routes = useMemo(
    () => (tracking?.legs ?? []).map((l, i) => ({ id: `${l.kind}-${i}`, kind: l.kind, coordinates: l.coordinates })),
    [tracking],
  );

  if (error) return <div className="page"><p className="error">{error}</p></div>;
  if (!order) return <div className="page-loading">Loading order…</div>;

  async function checkPayment() {
    setBusy(true);
    try {
      const { order: o } = await api(`/orders/${orderId}/payment/check`, { method: 'POST' });
      setOrder({ ...o, allowedNext: cancellable(o.status) });
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!window.confirm('Cancel this order?')) return;
    setBusy(true);
    try {
      setOrder((await api(`/orders/${orderId}/status`, { method: 'POST', body: { status: 'CANCELLED', note: 'Cancelled by customer' } })).order);
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  }

  const active = !TERMINAL.includes(order.status) && order.status !== 'PENDING_PAYMENT';
  const lastLeg = tracking?.legs?.at(-1);

  return (
    <div className="page track-page">
      <div className="track-map-wrap">
        <LiveMap className="track-map" center={order.delivery} zoom={14} markers={markers} routes={routes}
          fitKey={`${order.status}|${routes.length}|${showDriver}`} />
        {active && tracking?.etaSeconds != null && (
          <div className="eta-card">
            <div className="eta-big">{minutes(tracking.etaSeconds)}</div>
            <div className="small">Arriving around <strong>{clock(tracking.etaAt)}</strong></div>
            <div className="muted small">{PHASE_TEXT[tracking.phase]}</div>
            {lastLeg?.source === 'estimate' && <div className="muted tiny">Estimated without live traffic</div>}
          </div>
        )}
      </div>

      <div className="track-details stack">
        <div className="card">
          <div className="row between">
            <div>
              <h1 className="h2">{order.status === 'DELIVERED' ? 'Enjoy your meal! 🎉' : STATUS_LABEL[order.status]}</h1>
              <p className="muted small">Order #{order.id} · {order.restaurant.emoji} {order.restaurant.name}</p>
            </div>
            {order.allowedNext?.includes('CANCELLED') && (
              <button className="btn outline danger small" onClick={cancel} disabled={busy}>Cancel</button>
            )}
          </div>

          {order.status === 'PENDING_PAYMENT' && order.payment.method === 'card' && !order.payment.sandbox ? (
            <StripePay order={order} initialClientSecret={clientSecret} onOrder={(o) => setOrder({ ...o, allowedNext: cancellable(o.status) })} />
          ) : order.status === 'PENDING_PAYMENT' && (
            <div className="notice info">
              <p className="pulse">📱 {paymentMessage ?? 'Waiting for payment confirmation…'}</p>
              <button className="btn outline small" onClick={checkPayment} disabled={busy}>I've approved it</button>
            </div>
          )}
          {order.status === 'CANCELLED' && order.payment.status === 'failed' && (
            <div className="notice warn">Payment didn't go through, so the order was cancelled. <Link to="/checkout">Try again</Link></div>
          )}
          <StatusTimeline order={order} />
        </div>

        {showDriver && (
          <div className="card driver-card">
            <div className="avatar">🛵</div>
            <div className="grow">
              <strong>{order.driver.name}</strong>
              <div className="muted small">{order.driver.vehicle}</div>
              {driverPos && tracking?.legs?.[0] && (
                <div className="small">{km(tracking.legs[0].distanceKm)} {tracking.phase === 'delivering' ? 'from you' : 'from the restaurant'}</div>
              )}
            </div>
            {order.driver.phone && <a className="btn outline small" href={`tel:${order.driver.phone}`}>Call</a>}
          </div>
        )}

        <div className="card">
          <h2>Order summary</h2>
          <OrderLines items={order.items} />
          <div className="total-row"><span>Delivery fee</span><span>{ugx(order.deliveryFee)}</span></div>
          <div className="total-row grand"><span>Total</span><strong>{ugx(order.total)}</strong></div>
          <p className="muted small">
            {PAYMENT_LABEL[order.payment.method]} · {PAYMENT_STATUS_LABEL[order.payment.status] ?? order.payment.status}
          </p>
          <p className="small">📍 {order.delivery.address}</p>
          {order.delivery.notes && <p className="muted small">“{order.delivery.notes}”</p>}
        </div>
      </div>
    </div>
  );
}

// Customer-cancellable states mirror the server state machine.
const cancellable = (status) => (status === 'PENDING_PAYMENT' || status === 'PLACED' ? ['CANCELLED'] : []);
