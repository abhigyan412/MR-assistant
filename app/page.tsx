"use client";

import { useEffect, useState } from "react";
import { api, type Person } from "./client";
import { AdminView } from "./components/AdminView";
import { ManagerView } from "./components/ManagerView";
import { MrView } from "./components/MrView";

// Demo shell: pick who you are (no auth until Phase 4).

type Tab = "MR" | "MANAGER" | "ADMIN";

export default function Home() {
  const [people, setPeople] = useState<Person[]>([]);
  const [tab, setTab] = useState<Tab>("MR");
  const [personId, setPersonId] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.users().then(setPeople).catch((e) => setError(String(e)));
  }, []);

  const options = people.filter((p) =>
    tab === "MR" ? p.role === "MR" : tab === "MANAGER" ? p.role === "ABM" || p.role === "RBM" : p.role === "ADMIN"
  );
  useEffect(() => {
    if (!options.some((o) => o.id === personId)) setPersonId(options[0]?.id ?? "");
  }, [tab, people]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <main>
      <header className="top">
        <h1>MR Assistant</h1>
        <nav className="tabs">
          {(["MR", "MANAGER", "ADMIN"] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
              {t === "MR" ? "MR" : t === "MANAGER" ? "Manager" : "Admin"}
            </button>
          ))}
        </nav>
        <select value={personId} onChange={(e) => setPersonId(e.target.value)} aria-label="Who are you">
          {options.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.role}
              {p.territory ? `, ${p.territory.name}` : ""})
            </option>
          ))}
        </select>
      </header>
      {error && <p className="error">{error}</p>}
      {personId && tab === "MR" && <MrView key={personId} mrId={personId} />}
      {personId && tab === "MANAGER" && <ManagerView key={personId} managerId={personId} />}
      {personId && tab === "ADMIN" && <AdminView adminId={personId} mrs={people.filter((p) => p.role === "MR")} />}
    </main>
  );
}
