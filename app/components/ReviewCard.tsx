"use client";

import { useState } from "react";
import { api, type Catalog, type ReviewItem } from "../client";

// One review card = one question for the MR (or manager), answered in a tap.
// Every answer goes to POST /api/review-items/:id/resolve, which re-checks
// the whole note and writes it to the DCR once nothing blocking is left.

const TITLES: Record<string, string> = {
  DOCTOR_AMBIGUOUS: "Which doctor?",
  DOCTOR_NOT_FOUND: "New doctor?",
  PRODUCT_AMBIGUOUS: "Which product?",
  PRODUCT_NOT_FOUND: "Unknown product",
  MANAGER_AMBIGUOUS: "Who was with you?",
  QUANTITY_MISSING: "How many?",
  UNIT_UNKNOWN: "Which unit?",
  STOCK_INSUFFICIENT: "Not enough stock",
  LOW_CONFIDENCE: "Please check",
  VISIT_STATUS_CONFLICT: "Did you meet the doctor?",
  POSSIBLE_DUPLICATE_VISIT: "Already logged?",
  CORRECTION_REQUESTED: "Correct an earlier entry",
  ADVERSE_EVENT: "Possible adverse event",
};

export function ReviewCard({
  item,
  noteText,
  actorId,
  catalog,
  onDone,
}: {
  item: ReviewItem;
  noteText: string;
  actorId: string;
  catalog: Catalog | null;
  onDone: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qty, setQty] = useState("");
  const [unit, setUnit] = useState(item.candidates?.[0]?.id ?? "");
  const [chosen, setChosen] = useState<string[]>([]);
  const [showAll, setShowAll] = useState(false);
  const parsed = parseNewDoctor(item.rawMention ?? "");
  const [doc, setDoc] = useState(parsed);

  async function answer(resolution: unknown) {
    setBusy(true);
    setError(null);
    try {
      await api.resolve(item.id, actorId, resolution);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed";
      // Answered already (double tap, or a sibling card answered it): not an error, just refresh.
      if (!/already (RESOLVED|DISMISSED)/.test(msg)) {
        setError(msg);
        setBusy(false);
        return;
      }
    }
    // Stay disabled until the list has refreshed, so the card can't be tapped twice meanwhile.
    try {
      await onDone();
    } finally {
      setBusy(false);
    }
  }

  const candidates = item.candidates ?? [];
  const pickButtons = (
    <div className="choices">
      {candidates.map((c) => (
        <button key={c.id} disabled={busy} onClick={() => answer({ action: "pick", id: c.id })}>
          {c.label}
        </button>
      ))}
    </div>
  );
  const discard = (
    <button className="link danger" disabled={busy} onClick={() => answer({ action: "discard" })}>
      Discard this note
    </button>
  );

  let body: JSX.Element;
  switch (item.kind) {
    case "DOCTOR_AMBIGUOUS":
      body = (
        <>
          {pickButtons}
          {catalog && (
            <details open={showAll} onToggle={(e) => setShowAll((e.target as HTMLDetailsElement).open)}>
              <summary>Someone else</summary>
              <div className="choices">
                {catalog.doctors.map((d) => (
                  <button key={d.id} disabled={busy} onClick={() => answer({ action: "pick", id: d.id })}>
                    {d.name} · {d.specialty ?? ""} · {d.area ?? ""}
                  </button>
                ))}
              </div>
            </details>
          )}
          {discard}
        </>
      );
      break;
    case "DOCTOR_NOT_FOUND":
      body = (
        <>
          {candidates.length > 0 && (
            <>
              <p className="muted">Did you mean</p>
              {pickButtons}
            </>
          )}
          <div className="form">
            <input value={doc.name} onChange={(e) => setDoc({ ...doc, name: e.target.value })} placeholder="Doctor name" />
            <input value={doc.specialty} onChange={(e) => setDoc({ ...doc, specialty: e.target.value })} placeholder="Specialty" />
            <input value={doc.area} onChange={(e) => setDoc({ ...doc, area: e.target.value })} placeholder="Area" />
            <button
              className="primary"
              disabled={busy || doc.name.trim().length < 2}
              onClick={() =>
                answer({ action: "newDoctor", name: doc.name.trim(), specialty: doc.specialty.trim() || null, area: doc.area.trim() || null })
              }
            >
              Add new doctor (manager approves)
            </button>
          </div>
          {discard}
        </>
      );
      break;
    case "PRODUCT_AMBIGUOUS":
    case "PRODUCT_NOT_FOUND":
      body = (
        <>
          {pickButtons}
          {catalog && candidates.length === 0 && (
            <div className="choices">
              {catalog.products.map((p) => (
                <button key={p.id} disabled={busy} onClick={() => answer({ action: "pick", id: p.id })}>
                  {p.brandName}
                </button>
              ))}
            </div>
          )}
          <button className="link" disabled={busy} onClick={() => answer({ action: "drop" })}>
            Not our product — skip it
          </button>
        </>
      );
      break;
    case "MANAGER_AMBIGUOUS":
      body = (
        <>
          {pickButtons}
          <button className="link" disabled={busy} onClick={() => answer({ action: "drop" })}>
            No manager was there
          </button>
        </>
      );
      break;
    case "QUANTITY_MISSING":
    case "UNIT_UNKNOWN":
    case "STOCK_INSUFFICIENT":
      body = (
        <>
          <div className="form row">
            <input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))} placeholder="Qty" />
            <select value={unit} onChange={(e) => setUnit(e.target.value)}>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            <button className="primary" disabled={busy || !qty || !unit} onClick={() => answer({ action: "quantity", quantity: Number(qty), unit })}>
              Save
            </button>
          </div>
          <div className="row">
            {item.kind === "STOCK_INSUFFICIENT" && (
              <button
                className="link"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api.recheck(item.messageId);
                    onDone();
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Recheck (after admin logs the receipt)
              </button>
            )}
            <button className="link" disabled={busy} onClick={() => answer({ action: "drop" })}>
              Skip this item
            </button>
          </div>
        </>
      );
      break;
    case "LOW_CONFIDENCE":
      body = (
        <div className="row">
          <button className="primary" disabled={busy} onClick={() => answer({ action: "accept" })}>
            Looks right
          </button>
          {discard}
        </div>
      );
      break;
    case "VISIT_STATUS_CONFLICT":
      body = (
        <>
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => answer({ action: "visitStatus", met: true })}>
              Yes, I met them
            </button>
            <button disabled={busy} onClick={() => answer({ action: "visitStatus", met: false })}>
              No — not available (drop products)
            </button>
          </div>
          {discard}
        </>
      );
      break;
    case "POSSIBLE_DUPLICATE_VISIT":
      body = (
        <div className="row">
          <button disabled={busy} onClick={() => answer({ action: "sameVisit" })}>
            Same visit — discard this note
          </button>
          <button disabled={busy} onClick={() => answer({ action: "secondVisit" })}>
            A second visit
          </button>
        </div>
      );
      break;
    case "CORRECTION_REQUESTED":
      body = (
        <>
          <div className="checks">
            {candidates.map((c) => (
              <label key={c.id}>
                <input
                  type="checkbox"
                  checked={chosen.includes(c.id)}
                  onChange={(e) => setChosen(e.target.checked ? [...chosen, c.id] : chosen.filter((x) => x !== c.id))}
                />
                {c.label}
              </label>
            ))}
            {candidates.length === 0 && <p className="muted">No recent sample entries found to replace.</p>}
          </div>
          <div className="row">
            <button className="primary" disabled={busy || chosen.length === 0} onClick={() => answer({ action: "reverse", eventIds: chosen })}>
              Replace selected
            </button>
            <button disabled={busy} onClick={() => answer({ action: "notCorrection" })}>
              Not a correction
            </button>
          </div>
        </>
      );
      break;
    case "ADVERSE_EVENT":
      body = (
        <button className="primary" disabled={busy} onClick={() => answer({ action: "acknowledge" })}>
          Acknowledge — PV follow-up started
        </button>
      );
      break;
    default:
      body = <p className="muted">Unsupported card type {item.kind}</p>;
  }

  return (
    <div className={`card review ${item.blocking ? "" : "info"}`}>
      <div className="card-head">
        <strong>{TITLES[item.kind] ?? item.kind}</strong>
        {item.rawMention && <span className="mention">“{item.rawMention}”</span>}
      </div>
      {item.detail && <p>{item.detail}</p>}
      <p className="note-quote">{noteText}</p>
      {body}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function parseNewDoctor(raw: string) {
  const [name = "", specialty = "", area = ""] = raw.split(",").map((s) => s.trim());
  return { name, specialty, area };
}
