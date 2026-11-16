"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type ManagerQueue } from "../client";
import { ReviewCard } from "./ReviewCard";

// Minimal manager queue for Phase 1 (full dashboard is Phase 3):
// adverse events, MR-added doctors to approve, and MR cards still open.

export function ManagerView({ managerId }: { managerId: string }) {
  const [queue, setQueue] = useState<ManagerQueue | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.queue(managerId).then(setQueue).catch((e) => setError(String(e)));
  }, [managerId]);
  useEffect(refresh, [refresh]);

  if (!queue) return <p className="muted">{error ?? "Loading…"}</p>;
  return (
    <div className="layout">
      <section>
        <h2>For you ({queue.managerItems.length})</h2>
        {queue.managerItems.length === 0 && <p className="muted">Nothing waiting.</p>}
        {queue.managerItems.map((i) => (
          <div key={i.id}>
            <p className="muted">From {i.mrName}</p>
            <ReviewCard item={i} noteText={i.message.text} actorId={managerId} catalog={null} onDone={refresh} />
          </div>
        ))}

        <h2>New doctors to approve ({queue.pendingDoctors.length})</h2>
        {queue.pendingDoctors.map((d) => (
          <div key={d.id} className="card">
            <strong>{d.name}</strong>{" "}
            <span className="muted">
              {[d.specialty, d.area].filter(Boolean).join(" · ")} — added by {d.addedBy ?? "an MR"}
            </span>
            <div className="row">
              <button className="primary" onClick={() => api.decideDoctor(d.id, managerId, true).then(refresh)}>
                Approve
              </button>
              <button onClick={() => api.decideDoctor(d.id, managerId, false).then(refresh)}>Reject</button>
            </div>
          </div>
        ))}
      </section>
      <section>
        <h2>Still open with MRs ({queue.mrItemsOpen.length})</h2>
        <ul className="messages">
          {queue.mrItemsOpen.map((i) => (
            <li key={i.id}>
              <span className="badge">{i.mrName}</span> <strong>{i.kind}</strong> — {i.detail}
              <div className="muted">“{i.message.text}”</div>
            </li>
          ))}
          {queue.mrItemsOpen.length === 0 && <li className="muted">All clear.</li>}
        </ul>
      </section>
    </div>
  );
}
