import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { api, km, ugx, KAMPALA } from '../../lib.js';
import { useAuth, useDeliveryLocation } from '../../state.jsx';
import { AddressPicker, Empty } from '../../components/common.jsx';
import LiveMap from '../../components/LiveMap.jsx';

// Rough listing estimate (prep + ride at ~22 km/h on roads); live ETA comes from the router once ordered.
function etaRange(r) {
  const low = r.prepTimeMin + Math.round((((r.distanceKm ?? 2) * 1.35) / 22) * 60);
  return `${low}–${low + 10} min`;
}

export default function Home() {
  const { user } = useAuth();
  const { location, setLocation } = useDeliveryLocation();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const { results } = await api(`/search?q=${encodeURIComponent(query)}&lat=${location.lat}&lng=${location.lng}`);
        if (!cancelled) {
          setResults(results);
          setError('');
        }
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    }, query ? 250 : 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, location.lat, location.lng]);

  const markers = useMemo(
    () => [
      { id: 'home', kind: 'home', lat: location.lat, lng: location.lng, popup: 'Deliver here' },
      ...(results ?? []).map(({ restaurant: r }) => ({
        id: `r${r.id}`, kind: 'restaurant', emoji: r.emoji, lat: r.lat, lng: r.lng, muted: !r.isOpen,
        popup: `<b>${r.name}</b><br>${r.cuisine}<br><a href="/r/${r.id}">View menu</a>`,
      })),
    ],
    [results, location.lat, location.lng],
  );

  if (user && user.role !== 'customer') return <Navigate to={user.role === 'merchant' ? '/merchant' : '/driver'} replace />;

  return (
    <div className="page">
      <section className="hero">
        <div>
          <h1>Hungry? We deliver.</h1>
          <p className="muted">Restaurants that deliver to</p>
          <AddressPicker value={location} onChange={setLocation} />
        </div>
        <LiveMap className="hero-map" center={location} zoom={13} markers={markers} fitKey={`${location.lat},${location.lng},${results?.length}`} />
      </section>

      <div className="search-bar">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search restaurants, dishes or cuisines — e.g. rolex, pizza, curry"
          aria-label="Search"
        />
      </div>

      {error && <p className="error">{error}</p>}
      {results && results.length === 0 && (
        <Empty icon="🗺️" title={query ? `Nothing matches “${query}” nearby` : 'No restaurants deliver here yet'}>
          {!query && (
            <>
              <p className="muted">The demo restaurants are in Kampala, Uganda.</p>
              <button className="btn primary" onClick={() => setLocation(KAMPALA)}>Use central Kampala</button>
            </>
          )}
        </Empty>
      )}

      <div className="restaurant-grid">
        {results?.map(({ restaurant: r, items }) => (
          <Link key={r.id} to={`/r/${r.id}`} className={`card restaurant-card ${r.isOpen ? '' : 'closed'}`}>
            <div className="restaurant-emoji">{r.emoji}</div>
            <div className="restaurant-info">
              <h3>{r.name}</h3>
              <p className="muted small">{r.cuisine}</p>
              <p className="meta small">
                <span>⭐ {r.rating.toFixed(1)}</span>
                {r.distanceKm != null && <span>{km(r.distanceKm)}</span>}
                <span>{etaRange(r)}</span>
                <span>Delivery from {ugx(r.deliveryFee)}</span>
              </p>
              {!r.isOpen && <span className="badge status-CANCELLED">Closed</span>}
              {items.length > 0 && (
                <ul className="item-hits small">
                  {items.map((i) => (
                    <li key={i.id}>
                      {i.name} · {ugx(i.price)}{!i.available && ' (sold out)'}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
