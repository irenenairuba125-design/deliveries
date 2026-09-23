// Geospatial helpers: distance, bounding boxes, routing/ETA and geocoding.
// Routing provider order: Mapbox Directions (live traffic, needs MAPBOX_TOKEN)
// -> OSRM (OSRM_URL, public demo server by default) -> straight-line estimate.

const EARTH_RADIUS_KM = 6371;
const ROAD_FACTOR = 1.35; // straight-line -> road distance approximation
const FALLBACK_SPEED_KMH = 22; // typical urban motorbike speed incl. traffic

const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;
const OSRM_URL = process.env.OSRM_URL ?? 'https://router.project-osrm.org';

const toRad = (d) => (d * Math.PI) / 180;

export function haversineKm(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

// Cheap index-friendly prefilter before the exact haversine check.
export function boundingBox(lat, lng, km) {
  const dLat = km / 111.32;
  const dLng = km / (111.32 * Math.cos(toRad(lat)));
  return { minLat: lat - dLat, maxLat: lat + dLat, minLng: lng - dLng, maxLng: lng + dLng };
}

export function isValidLatLng(lat, lng) {
  return (
    typeof lat === 'number' && typeof lng === 'number' &&
    Number.isFinite(lat) && Number.isFinite(lng) &&
    Math.abs(lat) <= 90 && Math.abs(lng) <= 180
  );
}

function straightLineRoute(from, to) {
  const km = haversineKm(from.lat, from.lng, to.lat, to.lng);
  const steps = Math.max(2, Math.ceil(km * 8));
  const coordinates = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    coordinates.push([from.lat + (to.lat - from.lat) * t, from.lng + (to.lng - from.lng) * t]);
  }
  const distanceKm = km * ROAD_FACTOR;
  return {
    distanceKm,
    durationSec: Math.round((distanceKm / FALLBACK_SPEED_KMH) * 3600),
    coordinates,
    source: 'estimate',
  };
}

async function mapboxRoute(from, to) {
  const url =
    `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/` +
    `${from.lng},${from.lat};${to.lng},${to.lat}?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`Mapbox ${res.status}`);
  const route = (await res.json()).routes?.[0];
  if (!route) throw new Error('Mapbox: no route');
  return {
    distanceKm: route.distance / 1000,
    durationSec: Math.round(route.duration),
    coordinates: route.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
    source: 'mapbox',
  };
}

async function osrmRoute(from, to) {
  const url = `${OSRM_URL}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
  const res = await fetch(url, { signal: AbortSignal.timeout(3500) });
  if (!res.ok) throw new Error(`OSRM ${res.status}`);
  const route = (await res.json()).routes?.[0];
  if (!route) throw new Error('OSRM: no route');
  return {
    distanceKm: route.distance / 1000,
    durationSec: Math.round(route.duration),
    coordinates: route.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
    source: 'osrm',
  };
}

const routeCache = new Map(); // key -> { at, route }
const ROUTE_CACHE_MS = 60_000;
let providerDownUntil = 0; // back off when the remote router is unreachable

export async function getRoute(from, to) {
  const key = [from.lat, from.lng, to.lat, to.lng].map((n) => n.toFixed(4)).join(',');
  const cached = routeCache.get(key);
  if (cached && Date.now() - cached.at < ROUTE_CACHE_MS) return cached.route;

  let route;
  if (Date.now() > providerDownUntil && (MAPBOX_TOKEN || OSRM_URL !== 'off')) {
    try {
      route = MAPBOX_TOKEN ? await mapboxRoute(from, to) : await osrmRoute(from, to);
    } catch (err) {
      providerDownUntil = Date.now() + 60_000;
      console.warn(`[geo] routing provider failed (${err.message}); using straight-line estimate for 60s`);
    }
  }
  route ??= straightLineRoute(from, to);

  routeCache.set(key, { at: Date.now(), route });
  if (routeCache.size > 2000) routeCache.delete(routeCache.keys().next().value);
  return route;
}

// Offline fallback for address autocomplete so the demo works without network.
const KAMPALA_PLACES = [
  ['Kampala Road, Central Division', 0.3136, 32.5811],
  ['Acacia Mall, Kisementi', 0.3353, 32.5936],
  ['Garden City Mall, Yusuf Lule Rd', 0.3197, 32.5919],
  ['Makerere University, Wandegeya', 0.3355, 32.5680],
  ['Nakasero Market', 0.3163, 32.5790],
  ['Kabalagala, Ggaba Road', 0.2958, 32.6007],
  ['Ntinda Shopping Centre', 0.3521, 32.6123],
  ['Bugolobi Village Mall', 0.3180, 32.6200],
  ['Muyenga Hill', 0.2900, 32.6100],
  ['Kololo Airstrip', 0.3290, 32.5960],
  ['Old Taxi Park', 0.3129, 32.5764],
  ['Mulago Hospital', 0.3380, 32.5760],
];

export async function autocomplete(query) {
  const q = query.trim();
  if (q.length < 2) return [];
  try {
    const url =
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&countrycodes=ug&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(3000),
      headers: { 'User-Agent': 'food-delivery-demo/0.1 (dev)' },
    });
    if (!res.ok) throw new Error(`Nominatim ${res.status}`);
    const rows = await res.json();
    if (rows.length) {
      return rows.map((r) => ({ label: r.display_name, lat: Number(r.lat), lng: Number(r.lon) }));
    }
  } catch {
    // fall through to offline list
  }
  const needle = q.toLowerCase();
  return KAMPALA_PLACES.filter(([label]) => label.toLowerCase().includes(needle)).map(([label, lat, lng]) => ({
    label,
    lat,
    lng,
  }));
}
