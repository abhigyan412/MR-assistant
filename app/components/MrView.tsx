"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, NetworkError, newId, STALE_PROCESSING_MS, todayIst, type Catalog, type Dcr, type Message, type NoteBody, type StockRow } from "../client";
import { DcrView } from "./DcrView";
import { ReviewCard } from "./ReviewCard";
import { VoiceRecorder, type VoiceResult } from "./VoiceRecorder";

// An unsent draft survives a reload / dropped connection on this device.
const DRAFT_KEY = "mr-assistant:draft";
type Voice = Pick<VoiceResult, "transcript" | "audio">;
type Draft = { id: string; text: string; voice?: Voice | null };
function loadDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as Draft) : null;
  } catch {
    return null;
  }
}
function saveDraft(d: Draft | null) {
  try {
    if (d && d.text.trim()) localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* storage unavailable: draft just isn't persisted */
  }
}

const isStale = (m: Message) => m.status === "RECEIVED" && Date.now() - new Date(m.lastAttemptAt).getTime() > STALE_PROCESSING_MS;

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
  const last = useRef<NoteBody | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  // The current note came from the mic: raw transcript + audio info travel with it.
  const [voice, setVoice] = useState<Voice | null>(null);

  // Restore an unsent draft (same id, so sending it later can't double count).
  useEffect(() => {
    const d = loadDraft();
    if (d) {
      draftId.current = d.id;
      setText(d.text);
      setVoice(d.voice ?? null);
    }
  }, []);

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

  // While any note is processing, keep checking (a dropped request may still finish on the server).
  const processing = messages.some((m) => m.status === "RECEIVED" && !isStale(m));
  useEffect(() => {
    if (!processing) return;
    const t = setInterval(() => refresh().catch(() => undefined), 4000);
    return () => clearInterval(t);
  }, [processing, refresh]);

  async function retry(messageId: string) {
    setRetrying(messageId);
    setToast(null);
    try {
      const m = await api.retry(messageId);
      setToast(m.status === "FAILED" ? `Still failing: ${m.errorReason ?? "error"}` : "Retried.");
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Retry failed");
    } finally {
      setRetrying(null);
      await refresh().catch(() => undefined);
    }
  }

  /** Returns true when the server has the note (whatever its status), false when it never arrived. */
  async function send(payload: NoteBody): Promise<boolean> {
    setSending(true);
    setToast(null);
    try {
      const { message, isDuplicate } = await api.sendNote({ ...payload, mrId });
      last.current = payload;
      setToast(
        isDuplicate
          ? "Already received — nothing counted twice."
          : message.reviewItems.some((r) => r.kind === "STOCK_REPORT")
            ? "Stock report sent to your manager for approval."
            : message.status === "PROCESSED" && nothingRecorded(message)
              ? "Nothing to record found — mention the doctor and what you detailed/gave, or a stock change (e.g. \"Gastrova ke 20 strip aaye\")."
            : message.status === "PROCESSED"
            ? "Added to today's DCR."
            : message.status === "NEEDS_REVIEW"
              ? "A quick question before it goes into the DCR."
              : message.status === "FAILED"
                ? `Could not process: ${message.errorReason ?? "error"}`
                : STATUS_LABEL[message.status]
      );
      await refresh();
      return true;
    } catch (e) {
      if (e instanceof NetworkError) {
        // The server may still have it (slow network): check before calling it lost.
        const latest = await api.messages(mrId).catch(() => null);
        if (latest) setMessages(latest);
        if (latest?.some((m) => m.id === payload.messageId)) {
          setToast("Slow network — your note arrived and is being processed.");
          return true;
        }
        setToast(`${e.message}. Your note is kept here — tap Send again; it won't be counted twice.`);
        return false;
      }
      setToast(e instanceof Error ? e.message : "Send failed");
      return false;
    } finally {
      setSending(false);
    }
  }

  // Stock reports waiting for the manager, per product (base units, signed).
  const pending = new Map<string, number>();
  for (const m of messages)
    for (const r of m.reviewItems)
      if (r.kind === "STOCK_REPORT" && r.status === "OPEN" && r.proposal)
        pending.set(r.proposal.productId, (pending.get(r.proposal.productId) ?? 0) + (r.proposal.direction === "received" ? 1 : -1) * r.proposal.baseQuantity);

  const openCards = messages.flatMap((m) =>
    m.reviewItems.filter((r) => r.status === "OPEN" && r.assignee === "MR").map((r) => ({ item: r, note: m.text }))
  );

  return (
    <div className="layout">
      <section>
        <h2>New note</h2>
        <VoiceRecorder
          mrId={mrId}
          disabled={sending}
          onStart={() => {
            // Recording starts the note (unless the MR already started typing it).
            if (!draftId.current) draftId.current = newId();
            return draftId.current;
          }}
          onResult={(r) => {
            if (!r.transcript) return;
            const nextText = text.trim() ? `${text.trim()} ${r.transcript}` : r.transcript;
            // Several recordings for one note: keep every raw transcript, sum the audio.
            const nextVoice: Voice = voice
              ? {
                  transcript: `${voice.transcript} ${r.transcript}`.trim(),
                  audio: { ...r.audio, segments: voice.audio.segments + r.audio.segments, durationMs: voice.audio.durationMs + r.audio.durationMs },
                }
              : { transcript: r.transcript, audio: r.audio };
            setText(nextText);
            setVoice(nextVoice);
            saveDraft({ id: draftId.current!, text: nextText, voice: nextVoice });
          }}
        />
        <textarea
          rows={4}
          value={text}
          placeholder="Bolo ya likho / Speak or type — e.g. Tiwari sir ko Gastrova detail kiya, 3 strip diye, Friday follow up"
          onChange={(e) => {
            if (!draftId.current && e.target.value.trim()) draftId.current = newId();
            setText(e.target.value);
            saveDraft(draftId.current ? { id: draftId.current, text: e.target.value, voice } : null);
          }}
        />
        {voice && (
          <p className="muted small">
            🎤 Heard: “{voice.transcript}” — edit the text above if anything is wrong.
          </p>
        )}
        <div className="row">
          <button
            className="primary"
            disabled={sending || !text.trim()}
            onClick={async () => {
              const payload: NoteBody = {
                messageId: draftId.current ?? newId(),
                text: text.trim(),
                recordedAt: new Date().toISOString(),
                ...(voice ? { transcript: voice.transcript, audio: voice.audio } : {}),
              };
              draftId.current = payload.messageId;
              if (await send(payload)) {
                setText("");
                setVoice(null);
                draftId.current = null;
                saveDraft(null);
              }
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
              {m.channel === "WEB_VOICE" && <span className="badge">🎤 Voice</span>}
              {m.status === "PROCESSED" && nothingRecorded(m) && <span className="badge warn">Nothing recorded</span>}
              {m.reviewItems
                .filter((r) => r.kind === "STOCK_REPORT" && r.status !== "DISMISSED")
                .map((r) => (
                  <span key={r.id} className={`badge ${r.status === "OPEN" ? "warn" : ""}`}>
                    {r.proposal?.direction === "received" ? "+" : "−"}
                    {r.proposal?.quantity} {r.proposal?.unit} {r.proposal?.productName}:{" "}
                    {r.status === "OPEN" ? "waiting for manager" : r.resolution?.action === "approve" ? "approved" : "rejected"}
                  </span>
                ))}
              <span className="msg-text">{m.text}</span>
              {m.transcript && m.transcript.trim() !== m.text.trim() && <span className="heard">Heard: “{m.transcript}”</span>}
              {m.audioKey && <AudioPlayback messageId={m.id} />}
              {m.status === "FAILED" && <span className="error"> {m.errorReason}</span>}
              {isStale(m) && <span className="error"> Taking too long — it may have been interrupted.</span>}
              {(m.status === "FAILED" || isStale(m)) && (
                <button className="link" disabled={retrying === m.id} onClick={() => retry(m.id)}>
                  {retrying === m.id ? "Retrying…" : "Retry"}
                </button>
              )}
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
                  {pending.get(s.productId) ? (
                    <span className="muted small">
                      {" "}
                      ({pending.get(s.productId)! > 0 ? "+" : ""}
                      {pending.get(s.productId)} pending)
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

/** Plays a voice note's recorded segments (short-lived signed URLs, fetched on demand). */
function AudioPlayback({ messageId }: { messageId: string }) {
  const [urls, setUrls] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (urls)
    return urls.length ? (
      <span className="playback">
        {urls.map((u, i) => (
          <audio key={u} controls preload="none" src={u} aria-label={"Recording part " + (i + 1)} />
        ))}
      </span>
    ) : (
      <span className="muted small"> Recording deleted (retention).</span>
    );
  return (
    <button
      className="link"
      onClick={() =>
        api
          .audioUrls(messageId)
          .then((r) => setUrls(r.urls))
          .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load audio"))
      }
    >
      {error ?? "▶ Play recording"}
    </button>
  );
}

/** A processed note that produced no DCR entry and no question (e.g. small talk). */
function nothingRecorded(m: Message & { events?: unknown[] }): boolean {
  const events = m._count?.events ?? m.events?.length ?? 0;
  return events === 0 && m.reviewItems.length === 0;
}
