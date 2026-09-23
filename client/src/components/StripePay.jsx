import { useEffect, useRef, useState } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { api, ugx } from '../lib.js';

const stripePromises = new Map();
const getStripe = (key) => {
  if (!stripePromises.has(key)) stripePromises.set(key, loadStripe(key));
  return stripePromises.get(key);
};

// Stripe Payment Element for a pending card order. The server remains the source
// of truth: after confirming, we ask it to re-check the PaymentIntent.
export default function StripePay({ order, initialClientSecret, onOrder }) {
  const mountRef = useRef(null);
  const stripeRef = useRef(null);
  const elementsRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let element;
    (async () => {
      try {
        const { clientSecret: fetched, stripePublishableKey } = await api(`/orders/${order.id}/payment`);
        const clientSecret = initialClientSecret ?? fetched;
        if (!clientSecret || !stripePublishableKey) throw new Error('Card payments are not configured');
        const stripe = await getStripe(stripePublishableKey);
        if (cancelled) return;
        const elements = stripe.elements({ clientSecret, appearance: { theme: 'stripe', variables: { colorPrimary: '#ff5a1f' } } });
        element = elements.create('payment');
        element.mount(mountRef.current);
        element.on('ready', () => !cancelled && setReady(true));
        stripeRef.current = stripe;
        elementsRef.current = elements;
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => {
      cancelled = true;
      element?.destroy();
    };
  }, [order.id, initialClientSecret]);

  async function pay(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { error: stripeError } = await stripeRef.current.confirmPayment({
        elements: elementsRef.current,
        redirect: 'if_required',
        confirmParams: { return_url: window.location.href },
      });
      if (stripeError) throw new Error(stripeError.message);
      onOrder((await api(`/orders/${order.id}/payment/check`, { method: 'POST' })).order);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stripe-pay" onSubmit={pay}>
      <div ref={mountRef} />
      {!ready && !error && <p className="muted small">Loading secure card form…</p>}
      {error && <p className="error small">{error}</p>}
      <button className="btn primary block" disabled={!ready || busy}>{busy ? 'Processing…' : `Pay ${ugx(order.total)}`}</button>
    </form>
  );
}
