import { useEffect, useMemo, useState } from 'react';
import { api, ugx } from '../../lib.js';
import { Empty } from '../../components/common.jsx';
import { RestaurantSwitcher, useMerchantRestaurant } from './useMerchantRestaurant.jsx';

const blankItem = { name: '', description: '', category: 'Mains', price: '', available: true, modifiers: [] };

export default function MerchantMenu() {
  const { restaurants, restaurant, setSelectedId, error } = useMerchantRestaurant();
  const [items, setItems] = useState(null);
  const [editing, setEditing] = useState(null); // item draft or null
  const rid = restaurant?.id;

  useEffect(() => {
    if (!rid) return;
    setItems(null);
    api(`/restaurants/${rid}`).then((d) => setItems(d.menu), () => setItems([]));
  }, [rid]);

  const categories = useMemo(() => {
    const map = new Map();
    for (const i of items ?? []) map.set(i.category, [...(map.get(i.category) ?? []), i]);
    return [...map];
  }, [items]);

  if (error) return <div className="page"><p className="error">{error}</p></div>;
  if (!restaurants) return <div className="page-loading">Loading…</div>;
  if (!restaurant) return <div className="page"><Empty title="You don't have a restaurant yet" /></div>;

  const upsert = (item) => setItems((list) => (list.some((i) => i.id === item.id) ? list.map((i) => (i.id === item.id ? item : i)) : [...list, item]));

  async function toggleAvailable(item) {
    const { item: updated } = await api(`/merchant/restaurants/${rid}/menu/${item.id}`, { method: 'PATCH', body: { available: !item.available } });
    upsert(updated);
  }
  async function remove(item) {
    if (!window.confirm(`Delete ${item.name} from the menu?`)) return;
    await api(`/merchant/restaurants/${rid}/menu/${item.id}`, { method: 'DELETE' });
    setItems((list) => list.filter((i) => i.id !== item.id));
  }

  return (
    <div className="page">
      <div className="row between wrap">
        <div className="row">
          <h1>Menu</h1>
          <RestaurantSwitcher restaurants={restaurants} restaurant={restaurant} onChange={setSelectedId} />
        </div>
        <button className="btn primary" onClick={() => setEditing({ ...blankItem })}>+ Add item</button>
      </div>

      {!items ? <p className="muted">Loading…</p> : items.length === 0 && <Empty title="No menu items yet" />}
      {categories.map(([cat, list]) => (
        <section key={cat} className="menu-section">
          <h2>{cat}</h2>
          <div className="stack">
            {list.map((item) => (
              <div key={item.id} className={`card menu-admin-row ${item.available ? '' : 'soldout'}`}>
                <div className="grow">
                  <strong>{item.name}</strong> <span className="muted">· {ugx(item.price)}</span>
                  <div className="muted small">{item.description}</div>
                  {item.modifiers.length > 0 && (
                    <div className="small">
                      {item.modifiers.map((g) => `${g.name} (${g.options.length})`).join(' · ')}
                    </div>
                  )}
                </div>
                <label className="switch small" title="In stock">
                  <input type="checkbox" checked={item.available} onChange={() => toggleAvailable(item)} />
                  <span>{item.available ? 'In stock' : 'Sold out'}</span>
                </label>
                <button className="btn ghost small" onClick={() => setEditing(structuredClone(item))}>Edit</button>
                <button className="btn ghost small danger" onClick={() => remove(item)}>Delete</button>
              </div>
            ))}
          </div>
        </section>
      ))}

      {editing && (
        <ItemEditor
          draft={editing}
          restaurantId={rid}
          categories={categories.map(([c]) => c)}
          onClose={() => setEditing(null)}
          onSaved={(item) => {
            upsert(item);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function ItemEditor({ draft: initial, restaurantId, categories, onClose, onSaved }) {
  const [d, setD] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (patch) => setD((x) => ({ ...x, ...patch }));
  const setGroup = (gi, patch) => set({ modifiers: d.modifiers.map((g, i) => (i === gi ? { ...g, ...patch } : g)) });
  const setOption = (gi, oi, patch) =>
    setGroup(gi, { options: d.modifiers[gi].options.map((o, i) => (i === oi ? { ...o, ...patch } : o)) });

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const body = {
      name: d.name, description: d.description, category: d.category, available: d.available,
      price: Number(d.price),
      modifiers: d.modifiers.map((g) => ({
        ...g, min: Number(g.min), max: Number(g.max),
        options: g.options.map((o) => ({ ...o, price: Number(o.price || 0) })),
      })),
    };
    try {
      const { item } = d.id
        ? await api(`/merchant/restaurants/${restaurantId}/menu/${d.id}`, { method: 'PATCH', body })
        : await api(`/merchant/restaurants/${restaurantId}/menu`, { method: 'POST', body });
      onSaved(item);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal wide" onSubmit={save} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        <h2>{d.id ? 'Edit item' : 'New item'}</h2>
        <div className="grid-2">
          <label>Name<input required value={d.name} onChange={(e) => set({ name: e.target.value })} /></label>
          <label>
            Category
            <input list="cats" value={d.category} onChange={(e) => set({ category: e.target.value })} />
            <datalist id="cats">{categories.map((c) => <option key={c} value={c} />)}</datalist>
          </label>
          <label>Price (UGX)<input required type="number" min="0" step="100" value={d.price} onChange={(e) => set({ price: e.target.value })} /></label>
          <label className="switch">
            <input type="checkbox" checked={d.available} onChange={(e) => set({ available: e.target.checked })} />
            <span>In stock</span>
          </label>
        </div>
        <label>Description<textarea rows={2} value={d.description} onChange={(e) => set({ description: e.target.value })} /></label>

        <h3>Options &amp; modifiers</h3>
        <p className="muted small">Sizes, toppings, spice level… “Min 1 / Max 1” makes a required single choice.</p>
        {d.modifiers.map((g, gi) => (
          <fieldset key={gi} className="modifier-editor">
            <div className="row">
              <input placeholder="Group name, e.g. Size" value={g.name} onChange={(e) => setGroup(gi, { name: e.target.value })} className="grow" />
              <label className="inline">Min<input type="number" min="0" value={g.min} onChange={(e) => setGroup(gi, { min: e.target.value })} /></label>
              <label className="inline">Max<input type="number" min="1" value={g.max} onChange={(e) => setGroup(gi, { max: e.target.value })} /></label>
              <button type="button" className="btn ghost small danger" onClick={() => set({ modifiers: d.modifiers.filter((_, i) => i !== gi) })}>Remove</button>
            </div>
            {g.options.map((o, oi) => (
              <div key={oi} className="row option-row">
                <input placeholder="Option" value={o.name} onChange={(e) => setOption(gi, oi, { name: e.target.value })} className="grow" />
                <input type="number" min="0" step="100" placeholder="+UGX" value={o.price} onChange={(e) => setOption(gi, oi, { price: e.target.value })} />
                <button type="button" className="btn ghost small" aria-label="Remove option"
                  onClick={() => setGroup(gi, { options: g.options.filter((_, i) => i !== oi) })}>×</button>
              </div>
            ))}
            <button type="button" className="btn ghost small" onClick={() => setGroup(gi, { options: [...g.options, { name: '', price: 0 }] })}>+ Option</button>
          </fieldset>
        ))}
        <button type="button" className="btn outline small"
          onClick={() => set({ modifiers: [...d.modifiers, { id: `g${Date.now()}`, name: '', min: 0, max: 1, options: [{ name: '', price: 0 }] }] })}>
          + Modifier group
        </button>

        {error && <p className="error">{error}</p>}
        <div className="modal-footer">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </div>
  );
}
