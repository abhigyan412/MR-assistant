"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, newId, todayIst, type Catalog, type Dcr, type Message, type StockRow } from "../client";
import { DcrView } from "./DcrView";
import { ReviewCard } from "./ReviewCard";

const STATUS_LABEL: Record<Message["status"], string> = {
  RECEIVED: "Processing",
  PROCESSED: "In DCR",
  NEEDS_REVIEW: "Needs your answer",
  FAILED: "Failed",
  DISCARDED: "Discarded",
};

export function MrView({ mrId }: { mrId: string }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [dcr, setDcr] = useState<Dcr | null>(null);
  const [stock, setStock] = useState<StockRow[]>([]);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [date, setDate] = useState(todayIst());
  // The message id is created when the MR STARTS a note (on WhatsApp/voice:
  // when recording starts), so any retry of the same note reuses it.
  const draftId = useRef<string | null>(null);
  const last = useRef<{ messageId: string; text: string; recordedAt: string } | null>(null);

  const refresh = useCallback(async () => {
    const [m, d, s] = await Promise.all([api.messages(mrId), api.dcr(mrId, date), api.stock(mrId)]);
    setMessages(m);
    setDcr(d);
    setStock(s);
  }, [mrId, date]);

  useEffect(() => {
    refresh().catch((e) => setToast(String(e)));
    api.catalog(mrId).then(setCatalog).catch(() => setCatalog(null));
  }, [refresh, mrId]);

  async function send(payload: { messageId: string; text: string; recordedAt: string }) {
    setSending(true);
    setToast(null);
    try {
      const { message, isDuplicate } = await api.sendNote({ ...payload, mrId });
      last.current = payload;
      setToast(
        isDuplicate
          ? "Already received — nothing counted twice."
          : message.status === "PROCESSED"
            ? "Added to today's DCR."
            : message.status === "NEEDS_REVIEW"
              ? "A quick question before it goes into the DCR."
              : message.status === "FAILED"
                ? `Could not process: ${message.errorReason ?? "error"}`
                : STATUS_LABEL[message.status]
      );
      await refresh();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Send failed");
    } finally {
      setSending(false);
    }
  }

  const openCards = messages.flatMap((m) =>
    m.reviewItems.filter((r) => r.status === "OPEN" && r.assignee === "MR").map((r) => ({ item: r, note: m.text }))
  );

  return (
    <div className="layout">
      <section>
        <h2>New note</h2>
        <textarea
          rows={4}
          value={text}
          placeholder="e.g. Dr. Verma ko Zentapra detail kiya, 3 strip sample diye, next week follow up"
          onChange={(e) => {
            if (!draftId.current && e.target.value.trim()) draftId.current = newId();
            setText(e.target.value);
          }}
        />
        <div className="row">
          <button
            className="primary"
            disabled={sending || !text.trim()}
            onClick={async () => {
              const payload = { messageId: draftId.current ?? newId(), text: text.trim(), recordedAt: new Date().toISOString() };
              await send(payload);
              setText("");
              draftId.current = null;
            }}
          >
            {sending ? "Sending…" : "Send"}
          </button>
          <button disabled={sending || !last.current} onClick={() => last.current && send(last.current)} title="Simulates a resend on a bad network">
            Resend last
          </button>
        </div>
        {toast && <p className="toast">{toast}</p>}

        {openCards.length > 0 && (
          <>
            <h2>Needs your answer ({openCards.length})</h2>
            {openCards.map(({ item, note }) => (
              <ReviewCard key={item.id} item={item} noteText={note} actorId={mrId} catalog={catalog} onDone={refresh} />
            ))}
          </>
        )}

        <h2>Recent notes</h2>
        <ul className="messages">
          {messages.map((m) => (
            <li key={m.id}>
              <span className={`badge status-${m.status}`}>{STATUS_LABEL[m.status]}</span>
              {m.adverseEventFlag && <span className="badge warn">AE flagged</span>}
              <span className="msg-text">{m.text}</span>
              {m.status === "FAILED" && <span className="error"> {m.errorReason}</span>}
            </li>
          ))}
          {messages.length === 0 && <li className="muted">No notes yet.</li>}
        </ul>
      </section>

      <section>
        <div className="row spread">
          <h2>Daily Call Report</h2>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <DcrView dcr={dcr} />

        <h2>Sample stock</h2>
        <table className="stock">
          <tbody>
            {stock.map((s) => (
              <tr key={s.productId} className={s.balance <= 0 ? "low" : ""}>
                <td>{s.brandName}</td>
                <td className="num">
                  {s.balance} {s.baseUnit}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
