"use client";

import type { Dcr } from "../client";

// The Daily Call Report: one row per doctor visit, built from events only.

export function DcrView({ dcr }: { dcr: Dcr | null }) {
  if (!dcr) return <p className="muted">Loading DCR…</p>;
  const s = dcr.summary;
  return (
    <div>
      <div className="stats">
        <Stat label="Visits" value={s.visits} />
        <Stat label="Met" value={s.met} />
        <Stat label="Missed" value={s.missed} />
        <Stat label="Joint work" value={s.jointWorkVisits} />
        <Stat label="Sample units" value={s.samplesGivenBaseUnits} />
      </div>

      {dcr.visits.length === 0 && <p className="muted">No visits logged for {dcr.date}.</p>}

      <div className="dcr">
        {dcr.visits.map((v) => (
          <div key={v.visitId} className={`card visit ${v.met ? "" : "missed"}`}>
            <div className="card-head">
              <strong>{v.doctor.name}</strong>
              <span className="muted">
                {[v.doctor.specialty, v.doctor.area].filter(Boolean).join(" · ")}
                {v.time ? ` · ${v.time}` : ""}
              </span>
              {!v.met && <span className="badge warn">Not met</span>}
              {v.doctor.pendingApproval && <span className="badge">New doctor — pending approval</span>}
            </div>
            <dl>
              {v.detailed.length > 0 && <Row label="Detailed" value={v.detailed.join(", ")} />}
              {v.samples.length > 0 && (
                <Row label="Samples" value={v.samples.map((x) => `${x.product} × ${x.quantity} ${x.unit}`).join(", ")} />
              )}
              {v.pobs.length > 0 && (
                <Row
                  label="POB"
                  value={v.pobs.map((x) => `${x.product} × ${x.quantity} ${x.unit}${x.chemist ? ` via ${x.chemist}` : ""}`).join(", ")}
                />
              )}
              {v.jointWork.length > 0 && <Row label="Joint work" value={v.jointWork.join(", ")} />}
              {v.queries.map((q, i) => (
                <Row key={i} label="Query" value={`${q.question}${q.product ? ` (${q.product})` : ""}`} />
              ))}
              {v.followUps.map((f, i) => (
                <Row
                  key={i}
                  label="Follow-up"
                  value={`${f.action}${f.dueDate ? ` — ${f.dueDate}` : ""}${f.provisionalRule ? " (date rule pending confirmation)" : ""}`}
                />
              ))}
            </dl>
          </div>
        ))}
      </div>

      {dcr.chemistCalls.length > 0 && (
        <>
          <h3>Chemist calls</h3>
          {dcr.chemistCalls.map((c, i) => (
            <div key={i} className="card">
              <strong>{c.chemist}</strong>
              <dl>
                <Row label="POB" value={c.pobs.map((p) => `${p.product} × ${p.quantity} ${p.unit}`).join(", ")} />
              </dl>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
