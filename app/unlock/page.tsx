"use client";

import { useState } from "react";

// One-time passcode screen for the demo deployment (see lib/demo-gate.ts).
export default function Unlock() {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (res.ok) {
        window.location.href = "/";
        return;
      }
      setError("Wrong passcode / गलत पासकोड");
    } catch {
      setError("No connection — try again");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="unlock">
      <h1>MR Assistant</h1>
      <p className="muted">Demo passcode / डेमो पासकोड</p>
      <form onSubmit={submit} className="form">
        <input
          autoFocus
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="passcode"
          aria-label="Demo passcode"
        />
        <button className="primary" disabled={busy || !code.trim()}>
          {busy ? "Checking…" : "Enter / खोलें"}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </main>
  );
}
