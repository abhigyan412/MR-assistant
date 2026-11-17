"use client";

import { useEffect, useRef, useState } from "react";
import { api, newId, type Catalog, type Person } from "../client";

// Admin manual entry of samples sent to an MR (dispatch-file upload comes later).

export function AdminView({ adminId, mrs }: { adminId: string; mrs: Person[] }) {
  const [mrId, setMrId] = useState(mrs[0]?.id ?? "");
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [productId, setProductId] = useState("");
  const [qty, setQty] = useState("");
  const [unit, setUnit] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const entryId = useRef(newId()); // one id per form fill: double-click can't double the stock

  useEffect(() => {
    if (!mrId) return;
    setCatalog(null);
    api
      .catalog(mrId)
      .then((c) => {
        setCatalog(c);
        setProductId(c.products[0]?.id ?? "");
        setUnit(c.products[0]?.baseUnit ?? "");
      })
      .catch((e) => setMsg(e instanceof Error ? e.message : "Could not load products"));
  }, [mrId]);

  const product = catalog?.products.find((p) => p.id === productId);

  return (
    <section className="narrow">
      <h2>Log samples sent to an MR</h2>
      <div className="form">
        <label>
          MR
          <select value={mrId} onChange={(e) => setMrId(e.target.value)}>
            {mrs.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} — {m.territory?.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Product
          <select
            value={productId}
            onChange={(e) => {
              setProductId(e.target.value);
              setUnit(catalog?.products.find((p) => p.id === e.target.value)?.baseUnit ?? "");
            }}
          >
            {catalog?.products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.brandName}
              </option>
            ))}
          </select>
        </label>
        <div className="row">
          <input inputMode="numeric" placeholder="Quantity" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))} />
          <select value={unit} onChange={(e) => setUnit(e.target.value)}>
            {product && <option value={product.baseUnit}>{product.baseUnit}</option>}
            {product?.units.map((u) => (
              <option key={u.unit} value={u.unit}>
                {u.unit} ({u.toBase} {product.baseUnit})
              </option>
            ))}
          </select>
        </div>
        <input placeholder="Note (e.g. dispatch number)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button
          className="primary"
          disabled={!qty || !productId}
          onClick={async () => {
            try {
              const r = await api.addReceipt({ entryId: entryId.current, adminId, mrId, productId, quantity: Number(qty), unit, note: note || null });
              setMsg(r.duplicate ? "Already recorded — not counted twice." : "Recorded.");
              entryId.current = newId();
              setQty("");
              setNote("");
            } catch (e) {
              setMsg(e instanceof Error ? e.message : "Failed");
            }
          }}
        >
          Record receipt
        </button>
        {msg && <p className="toast">{msg}</p>}
      </div>
    </section>
  );
}
