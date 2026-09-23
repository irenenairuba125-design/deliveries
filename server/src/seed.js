// Demo data around Kampala, Uganda. Runs automatically on an empty database;
// `npm run seed:reset` wipes and re-seeds.
import { db } from './db/index.js';
import { hashPassword } from './auth.js';

export const DEMO_PASSWORD = 'password123';

const size = (reg, large) => ({
  id: 'size', name: 'Size', min: 1, max: 1,
  options: [{ id: 'reg', name: 'Regular', price: reg }, { id: 'large', name: 'Large', price: large }],
});
const spice = {
  id: 'spice', name: 'Spice level', min: 1, max: 1,
  options: [
    { id: 'mild', name: 'Mild', price: 0 },
    { id: 'medium', name: 'Medium', price: 0 },
    { id: 'hot', name: 'Hot 🌶️', price: 0 },
  ],
};
const extras = (opts) => ({
  id: 'extras', name: 'Extras', min: 0, max: opts.length,
  options: opts.map(([id, name, price]) => ({ id, name, price })),
});

const RESTAURANTS = [
  {
    owner: 'merchant@demo.test', name: 'Rolex Republic', emoji: '🌯', cuisine: 'Ugandan · Street food',
    description: 'Freshly rolled chapati & egg rolexes, the Kampala classic.',
    address: 'Kisementi, Kololo', lat: 0.3326, lng: 32.5936, radius: 6, prep: 10, fee: 2500, rating: 4.8,
    menu: [
      ['Rolex', 'Classic', 'Chapati rolled with a two-egg omelette, tomato & cabbage.', 5000,
        [extras([['egg', 'Extra egg', 1000], ['avo', 'Avocado', 1500], ['cheese', 'Cheese', 2000], ['sausage', 'Sausage', 2500]]), spice]],
      ['Kikomando', 'Classic', 'Chopped chapati with spiced beans.', 4000, [spice]],
      ['Chicken Rolex', 'Specials', 'Grilled chicken strips, egg & veg in chapati.', 9000,
        [extras([['avo', 'Avocado', 1500], ['cheese', 'Cheese', 2000]]), spice]],
      ['Passion juice', 'Drinks', 'Fresh passion fruit juice.', 3000, [size(0, 2000)]],
    ],
  },
  {
    owner: 'merchant@demo.test', name: 'Kampala Pizza Co.', emoji: '🍕', cuisine: 'Pizza · Italian',
    description: 'Wood-fired pizzas with local toppings.',
    address: 'Nakasero Road, Nakasero', lat: 0.3244, lng: 32.5794, radius: 7, prep: 20, fee: 3500, rating: 4.5,
    menu: [
      ['Margherita', 'Pizza', 'Tomato, mozzarella, basil.', 28000,
        [{ id: 'size', name: 'Size', min: 1, max: 1, options: [
          { id: 'm', name: 'Medium', price: 0 }, { id: 'l', name: 'Large', price: 8000 }, { id: 'xl', name: 'Family', price: 16000 }] },
        extras([['cheese', 'Extra cheese', 4000], ['olives', 'Olives', 3000], ['chili', 'Chili flakes', 0]])]],
      ['Chicken Tikka Pizza', 'Pizza', 'Tikka chicken, onion, green pepper.', 35000,
        [{ id: 'size', name: 'Size', min: 1, max: 1, options: [
          { id: 'm', name: 'Medium', price: 0 }, { id: 'l', name: 'Large', price: 8000 }] }]],
      ['Garlic bread', 'Sides', 'Toasted with herb butter.', 9000, []],
      ['Soda', 'Drinks', 'Coke, Fanta or Sprite (500ml).', 3000,
        [{ id: 'flavor', name: 'Flavour', min: 1, max: 1, options: [
          { id: 'coke', name: 'Coke', price: 0 }, { id: 'fanta', name: 'Fanta', price: 0 }, { id: 'sprite', name: 'Sprite', price: 0 }] }]],
    ],
  },
  {
    owner: 'merchant2@demo.test', name: 'Spice Route', emoji: '🍛', cuisine: 'Indian · Curry',
    description: 'Slow-cooked curries and tandoor breads.',
    address: 'Ggaba Road, Kabalagala', lat: 0.2966, lng: 32.5998, radius: 6, prep: 25, fee: 4000, rating: 4.6,
    menu: [
      ['Butter chicken', 'Curries', 'Creamy tomato-butter sauce, served with rice.', 32000, [spice]],
      ['Chana masala', 'Curries', 'Chickpeas in a tangy onion-tomato gravy.', 22000, [spice]],
      ['Garlic naan', 'Breads', 'From the tandoor.', 6000, []],
      ['Mango lassi', 'Drinks', 'Yoghurt & mango.', 8000, [size(0, 3000)]],
    ],
  },
  {
    owner: 'merchant2@demo.test', name: 'Green Bowl', emoji: '🥗', cuisine: 'Healthy · Bowls',
    description: 'Fresh salads, grain bowls and smoothies.',
    address: 'Ntinda Shopping Centre', lat: 0.3530, lng: 32.6146, radius: 5, prep: 12, fee: 3000, rating: 4.4,
    menu: [
      ['Matooke power bowl', 'Bowls', 'Steamed matooke, g-nut sauce, greens.', 18000,
        [extras([['avo', 'Avocado', 3000], ['egg', 'Boiled egg', 1500]])]],
      ['Grilled tilapia bowl', 'Bowls', 'Lake Victoria tilapia, brown rice, kachumbari.', 26000, []],
      ['Green smoothie', 'Drinks', 'Spinach, pineapple, banana.', 10000, [size(0, 4000)]],
    ],
  },
  {
    owner: 'merchant2@demo.test', name: 'Nile Burger', emoji: '🍔', cuisine: 'Burgers · Fast food',
    description: 'Smash burgers and crispy chips.',
    address: 'Wandegeya, near Makerere', lat: 0.3336, lng: 32.5710, radius: 6, prep: 15, fee: 3000, rating: 4.3,
    menu: [
      ['Smash burger', 'Burgers', 'Double beef patty, cheese, pickles.', 22000,
        [extras([['bacon', 'Bacon', 4000], ['cheese', 'Extra cheese', 2000], ['egg', 'Fried egg', 2000]]),
          { id: 'side', name: 'Side', min: 0, max: 1, options: [
            { id: 'chips', name: 'Chips', price: 5000 }, { id: 'salad', name: 'Side salad', price: 4000 }] }]],
      ['Crispy chicken burger', 'Burgers', 'Buttermilk fried chicken, slaw.', 20000, []],
      ['Chips', 'Sides', 'Hand-cut, salted.', 6000, [size(0, 3000)]],
    ],
  },
];

const USERS = [
  ['customer@demo.test', 'Amina Nakato', '0772000001', 'customer'],
  ['merchant@demo.test', 'Joseph (Rolex Republic)', '0772000002', 'merchant'],
  ['merchant2@demo.test', 'Grace (Spice Route)', '0772000003', 'merchant'],
  ['driver@demo.test', 'Brian Okello', '0772000004', 'driver', 'Motorbike (boda)', 0.3190, 32.5850],
  ['driver2@demo.test', 'Sarah Achieng', '0752000005', 'driver', 'Motorbike (boda)', 0.3050, 32.5950],
];

export async function seedIfEmpty() {
  const { n } = await db.get('SELECT COUNT(*) AS n FROM users');
  if (n > 0) return false;
  const passwordHash = hashPassword(DEMO_PASSWORD);

  await db.tx(async (t) => {
    const ids = {};
    for (const [email, name, phone, role, vehicle, lat, lng] of USERS) {
      ({ id: ids[email] } = await t.get(
        'INSERT INTO users (email, password_hash, name, phone, role) VALUES (?, ?, ?, ?, ?) RETURNING id',
        [email, passwordHash, name, phone, role],
      ));
      if (role === 'driver') {
        await t.run('INSERT INTO drivers (user_id, vehicle, lat, lng, location_updated_at) VALUES (?, ?, ?, ?, ?)',
          [ids[email], vehicle, lat, lng, new Date().toISOString()]);
      }
    }
    for (const r of RESTAURANTS) {
      const { id: rid } = await t.get(`INSERT INTO restaurants
        (owner_id, name, description, cuisine, emoji, address, lat, lng, delivery_radius_km, prep_time_min, delivery_fee, rating)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [ids[r.owner], r.name, r.description, r.cuisine, r.emoji, r.address, r.lat, r.lng, r.radius, r.prep, r.fee, r.rating]);
      for (const [i, [name, category, description, price, modifiers]] of r.menu.entries()) {
        await t.run(`INSERT INTO menu_items (restaurant_id, category, name, description, price, modifiers, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?)`, [rid, category, name, description, price, JSON.stringify(modifiers), i]);
      }
    }
  });
  console.log(`[seed] demo data created (password for all demo accounts: ${DEMO_PASSWORD})`);
  return true;
}

// npm run seed:reset
if (process.argv[1] === import.meta.filename && process.argv.includes('--reset')) {
  await db.migrate();
  for (const table of ['order_events', 'order_items', 'orders', 'menu_items', 'restaurants', 'drivers', 'users']) {
    await db.run(`DELETE FROM ${table}`);
  }
  await seedIfEmpty();
  await db.close();
}
