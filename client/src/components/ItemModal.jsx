import { useEffect, useMemo, useState } from 'react';
import { ugx } from '../lib.js';

// Pick modifiers (size, toppings, spice…) for a menu item, mirroring the server's min/max rules.
export default function ItemModal({ item, onClose, onAdd }) {
  const [selections, setSelections] = useState(() =>
    Object.fromEntries(item.modifiers.map((g) => [g.id, g.min === 1 && g.max === 1 ? [g.options[0].id] : []])),
  );
  const [quantity, setQuantity] = useState(1);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggle = (group, optionId) => {
    setSelections((s) => {
      const cur = s[group.id] ?? [];
      if (group.max === 1) return { ...s, [group.id]: cur.includes(optionId) && group.min === 0 ? [] : [optionId] };
      if (cur.includes(optionId)) return { ...s, [group.id]: cur.filter((id) => id !== optionId) };
      if (cur.length >= group.max) return s;
      return { ...s, [group.id]: [...cur, optionId] };
    });
  };

  const { unitPrice, summary, missing } = useMemo(() => {
    let unit = item.price;
    const names = [];
    const missing = [];
    for (const g of item.modifiers) {
      const picked = selections[g.id] ?? [];
      if (picked.length < g.min) missing.push(g.name);
      for (const id of picked) {
        const o = g.options.find((x) => x.id === id);
        if (o) {
          unit += o.price;
          names.push(o.name);
        }
      }
    }
    return { unitPrice: unit, summary: names.join(', '), missing };
  }, [item, selections]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={item.name} onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        <h2>{item.name}</h2>
        <p className="muted">{item.description}</p>
        {item.modifiers.map((g) => (
          <fieldset key={g.id} className="modifier-group">
            <legend>
              {g.name}
              <span className="muted small">
                {g.min > 0 ? ` · Required${g.max > 1 ? `, pick ${g.min}–${g.max}` : ''}` : ` · Optional${g.max > 1 ? `, up to ${g.max}` : ''}`}
              </span>
            </legend>
            {g.options.map((o) => {
              const checked = (selections[g.id] ?? []).includes(o.id);
              return (
                <label key={o.id} className={`option ${checked ? 'checked' : ''}`}>
                  <input type={g.max === 1 ? 'radio' : 'checkbox'} name={g.id} checked={checked} onChange={() => toggle(g, o.id)} />
                  <span>{o.name}</span>
                  <span className="muted">{o.price ? `+${ugx(o.price)}` : ''}</span>
                </label>
              );
            })}
          </fieldset>
        ))}
        <div className="modal-footer">
          <div className="stepper">
            <button onClick={() => setQuantity((q) => Math.max(1, q - 1))} aria-label="Decrease">−</button>
            <span>{quantity}</span>
            <button onClick={() => setQuantity((q) => Math.min(50, q + 1))} aria-label="Increase">+</button>
          </div>
          <button
            className="btn primary grow"
            disabled={missing.length > 0}
            title={missing.length ? `Choose: ${missing.join(', ')}` : ''}
            onClick={() => onAdd({ selections, quantity, unitPrice, summary })}
          >
            {missing.length ? `Choose ${missing[0]}` : `Add ${quantity} · ${ugx(unitPrice * quantity)}`}
          </button>
        </div>
      </div>
    </div>
  );
}
