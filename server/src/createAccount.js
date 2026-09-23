// Create merchant (with a restaurant) or driver accounts, e.g. in production
// where demo data isn't seeded. Uses the same DATABASE_URL / DB_PATH as the server.
//
//   npm run create-account -- --role driver --email rider@x.ug --name "Rider" --phone 0772000000 --password '…'
//   npm run create-account -- --role merchant --email owner@x.ug --name "Owner" --password '…' \
//       --restaurant "Mama's Kitchen" --address "Kira Road" --lat 0.335 --lng 32.59 [--cuisine "Ugandan"] [--radius 5]
import { parseArgs } from 'node:util';
import { db } from './db/index.js';
import { hashPassword } from './auth.js';
import { isValidLatLng } from './geo.js';

const { values: a } = parseArgs({
  options: {
    role: { type: 'string' }, email: { type: 'string' }, name: { type: 'string' }, phone: { type: 'string' },
    password: { type: 'string' }, restaurant: { type: 'string' }, address: { type: 'string' }, cuisine: { type: 'string' },
    lat: { type: 'string' }, lng: { type: 'string' }, radius: { type: 'string' }, vehicle: { type: 'string' },
  },
});

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

if (!['merchant', 'driver', 'customer'].includes(a.role)) fail('--role must be merchant, driver or customer');
if (!/^\S+@\S+\.\S+$/.test(a.email ?? '')) fail('--email is required');
if (!a.name) fail('--name is required');
if (!a.password || a.password.length < 8) fail('--password must be at least 8 characters');
const lat = Number(a.lat);
const lng = Number(a.lng);
if (a.role === 'merchant') {
  if (!a.restaurant || !a.address) fail('merchants need --restaurant and --address');
  if (!isValidLatLng(lat, lng)) fail('merchants need valid --lat and --lng');
}

await db.migrate();
if (await db.get('SELECT 1 AS x FROM users WHERE lower(email) = lower(?)', [a.email])) fail(`${a.email} already exists`);

await db.tx(async (t) => {
  const { id } = await t.get('INSERT INTO users (email, password_hash, name, phone, role) VALUES (?, ?, ?, ?, ?) RETURNING id',
    [a.email, hashPassword(a.password), a.name, a.phone ?? null, a.role]);
  if (a.role === 'driver') {
    await t.run('INSERT INTO drivers (user_id, vehicle) VALUES (?, ?)', [id, a.vehicle ?? 'Motorbike (boda)']);
  }
  if (a.role === 'merchant') {
    const r = await t.get(`INSERT INTO restaurants (owner_id, name, cuisine, address, lat, lng, delivery_radius_km)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`, [id, a.restaurant, a.cuisine ?? '', a.address, lat, lng, Number(a.radius) || 5]);
    console.log(`restaurant #${r.id} "${a.restaurant}" created — add its menu from the Restaurant portal`);
  }
  console.log(`${a.role} account #${id} created for ${a.email}`);
});
await db.close();
