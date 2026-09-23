import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;
const TILE = MAPBOX_TOKEN
  ? {
      url: `https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/{z}/{x}/{y}?access_token=${MAPBOX_TOKEN}`,
      attribution: '© Mapbox © OpenStreetMap',
      tileSize: 512,
      zoomOffset: -1,
    }
  : { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors' };

const ROUTE_STYLE = {
  to_restaurant: { color: '#64748b', weight: 4, opacity: 0.8, dashArray: '6 8' },
  to_customer: { color: '#ff5a1f', weight: 5, opacity: 0.9 },
};

function iconFor(m) {
  if (m.kind === 'driver') {
    return L.divIcon({
      className: '',
      iconSize: [40, 40],
      iconAnchor: [20, 20],
      html: `<div class="pin-driver"><div class="pin-driver-arrow" style="transform:rotate(${m.heading ?? 0}deg)"></div><span>🛵</span></div>`,
    });
  }
  if (m.kind === 'me') {
    return L.divIcon({ className: '', iconSize: [18, 18], iconAnchor: [9, 9], html: '<div class="pin-me"></div>' });
  }
  const emoji = m.emoji ?? (m.kind === 'home' ? '🏠' : '🍽️');
  return L.divIcon({
    className: '',
    iconSize: [36, 44],
    iconAnchor: [18, 42],
    popupAnchor: [0, -38],
    html: `<div class="pin pin-${m.kind}${m.muted ? ' pin-muted' : ''}"><span>${emoji}</span></div>`,
  });
}

// Glide a marker to its new position instead of jumping (GPS updates arrive ~1/s).
function animateTo(marker, to, ms = 900) {
  cancelAnimationFrame(marker._anim);
  const from = marker.getLatLng();
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / ms);
    marker.setLatLng([from.lat + (to.lat - from.lat) * t, from.lng + (to.lng - from.lng) * t]);
    if (t < 1) marker._anim = requestAnimationFrame(step);
  };
  marker._anim = requestAnimationFrame(step);
}

/**
 * markers: [{ id, lat, lng, kind: 'restaurant'|'home'|'driver'|'me', emoji?, heading?, popup?, muted? }]
 * routes:  [{ id, kind: 'to_restaurant'|'to_customer', coordinates: [[lat,lng],...] }]
 * circles: [{ id, lat, lng, radiusKm }]
 * fitKey:  change it to re-fit the view to everything on the map
 */
export default function LiveMap({ center, zoom = 13, markers = [], routes = [], circles = [], fitKey, onClick, className = '' }) {
  const el = useRef(null);
  const map = useRef(null);
  const layers = useRef({ markers: new Map(), routes: new Map(), circles: new Map() });
  const clickRef = useRef(onClick);
  clickRef.current = onClick;

  useEffect(() => {
    const m = L.map(el.current, { zoomControl: true, attributionControl: true }).setView([center.lat, center.lng], zoom);
    L.tileLayer(TILE.url, { maxZoom: 19, ...TILE }).addTo(m);
    m.on('click', (e) => clickRef.current?.({ lat: e.latlng.lat, lng: e.latlng.lng }));
    map.current = m;
    // Containers inside flex/grid layouts may size after mount.
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      m.remove();
      map.current = null;
      layers.current = { markers: new Map(), routes: new Map(), circles: new Map() };
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // markers
  useEffect(() => {
    const m = map.current;
    const existing = layers.current.markers;
    const seen = new Set();
    for (const spec of markers) {
      if (spec.lat == null || spec.lng == null) continue;
      seen.add(spec.id);
      let marker = existing.get(spec.id);
      if (!marker) {
        marker = L.marker([spec.lat, spec.lng], { icon: iconFor(spec), zIndexOffset: spec.kind === 'driver' ? 1000 : 0 }).addTo(m);
        existing.set(spec.id, marker);
      } else {
        const cur = marker.getLatLng();
        if (cur.lat !== spec.lat || cur.lng !== spec.lng) {
          if (spec.kind === 'driver') animateTo(marker, spec);
          else marker.setLatLng([spec.lat, spec.lng]);
        }
        if (spec.kind === 'driver') {
          const arrow = marker.getElement()?.querySelector('.pin-driver-arrow');
          if (arrow) arrow.style.transform = `rotate(${spec.heading ?? 0}deg)`;
        } else if (marker._specKey !== `${spec.kind}|${spec.emoji}|${spec.muted}`) {
          marker.setIcon(iconFor(spec));
        }
      }
      marker._specKey = `${spec.kind}|${spec.emoji}|${spec.muted}`;
      if (spec.popup) marker.bindPopup(spec.popup);
      else marker.unbindPopup();
    }
    for (const [id, marker] of existing) {
      if (!seen.has(id)) {
        cancelAnimationFrame(marker._anim);
        marker.remove();
        existing.delete(id);
      }
    }
  }, [markers]);

  // routes
  useEffect(() => {
    const m = map.current;
    const existing = layers.current.routes;
    for (const line of existing.values()) line.remove();
    existing.clear();
    for (const r of routes) {
      if (!r.coordinates?.length) continue;
      existing.set(r.id, L.polyline(r.coordinates, ROUTE_STYLE[r.kind] ?? ROUTE_STYLE.to_customer).addTo(m));
    }
  }, [routes]);

  // circles
  useEffect(() => {
    const m = map.current;
    const existing = layers.current.circles;
    for (const c of existing.values()) c.remove();
    existing.clear();
    for (const c of circles) {
      existing.set(
        c.id,
        L.circle([c.lat, c.lng], { radius: c.radiusKm * 1000, color: '#ff5a1f', weight: 1, fillOpacity: 0.05 }).addTo(m),
      );
    }
  }, [circles]);

  // fit to content
  useEffect(() => {
    const m = map.current;
    if (!m || fitKey === undefined) return;
    const pts = [];
    for (const mk of layers.current.markers.values()) pts.push(mk.getLatLng());
    for (const r of layers.current.routes.values()) pts.push(...r.getLatLngs());
    // No animation: an auto-fit can land mid-way through a previous zoom animation and stall it.
    if (pts.length === 1) m.setView(pts[0], 15, { animate: false });
    else if (pts.length > 1) m.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 16, animate: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

  return <div ref={el} className={`map ${className}`} />;
}
