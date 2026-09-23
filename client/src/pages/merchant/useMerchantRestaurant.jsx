import { useEffect, useState } from 'react';
import { api, store } from '../../lib.js';

// Loads the merchant's restaurants and remembers which one they're managing.
export function useMerchantRestaurant() {
  const [restaurants, setRestaurants] = useState(null);
  const [selectedId, setSelectedIdState] = useState(() => store.get('merchantRestaurant'));
  const [error, setError] = useState('');

  useEffect(() => {
    api('/merchant/restaurants').then(({ restaurants }) => {
      setRestaurants(restaurants);
      setSelectedIdState((id) => (restaurants.some((r) => r.id === id) ? id : restaurants[0]?.id ?? null));
    }, (e) => setError(e.message));
  }, []);

  const setSelectedId = (id) => {
    setSelectedIdState(id);
    store.set('merchantRestaurant', id);
  };
  const restaurant = restaurants?.find((r) => r.id === selectedId) ?? null;
  const updateRestaurant = (r) => setRestaurants((list) => list.map((x) => (x.id === r.id ? r : x)));

  return { restaurants, restaurant, setSelectedId, updateRestaurant, error };
}

export function RestaurantSwitcher({ restaurants, restaurant, onChange }) {
  if (!restaurants || restaurants.length < 2) return null;
  return (
    <select value={restaurant?.id ?? ''} onChange={(e) => onChange(Number(e.target.value))} aria-label="Restaurant">
      {restaurants.map((r) => (
        <option key={r.id} value={r.id}>{r.emoji} {r.name}</option>
      ))}
    </select>
  );
}
