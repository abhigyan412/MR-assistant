"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "../client";

// Record a voice note on the phone and turn it into text.
//
// - Format: whatever MediaRecorder supports — webm/opus on Android Chrome,
//   mp4/AAC on iOS Safari — at ~24 kbps (slow mobile data).
// - Sarvam's synchronous API takes ≤30 s of audio, so the recording rolls to
//   a new segment every 25 s; each segment is a complete file and is uploaded
//   + transcribed as soon as it ends, so stopping only waits for the last one.
// - The note's message id is created when recording STARTS (onStart), so a
//   retried upload or a resent note stays idempotent.

const SEGMENT_MS = 25_000;
const MAX_MS = 120_000;
const BITRATE = 24_000;

export interface VoiceResult {
  transcript: string; // raw, joined segments — never edited
  audio: { mime: string; segments: number; durationMs: number; sttModel: string };
  failedSegments: number;
}

function pickMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm", "audio/aac"];
  return candidates.find((c) => MediaRecorder.isTypeSupported?.(c)) ?? "";
}

const fmt = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

export function VoiceRecorder({
  mrId,
  disabled,
  onStart,
  onResult,
}: {
  mrId: string;
  disabled: boolean;
  onStart: () => string; // returns the note's message id
  onResult: (r: VoiceResult) => void;
}) {
  const [state, setState] = useState<"idle" | "recording" | "finishing">("idle");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const segments = useRef<Promise<{ ok: boolean; text: string; model?: string }>[]>([]);
  const timers = useRef<{ tick?: ReturnType<typeof setInterval>; roll?: ReturnType<typeof setTimeout> }>({});
  const meta = useRef({ id: "", startedAt: 0, mime: "" });
  const wakeLock = useRef<{ release: () => Promise<void> } | null>(null);

  useEffect(() => () => cleanup(), []); // eslint-disable-line react-hooks/exhaustive-deps

  function cleanup() {
    clearInterval(timers.current.tick);
    clearTimeout(timers.current.roll);
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    wakeLock.current?.release().catch(() => undefined);
    wakeLock.current = null;
  }

  async function upload(blob: Blob, index: number): Promise<{ ok: boolean; text: string; model?: string }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await api.transcribe({ audio: blob, messageId: meta.current.id, segment: index, mrId });
        return { ok: true, text: r.transcript, model: r.model };
      } catch {
        await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
      }
    }
    return { ok: false, text: "" };
  }

  function startSegment() {
    const s = stream.current;
    if (!s) return;
    const index = segments.current.length;
    const opts: MediaRecorderOptions = { audioBitsPerSecond: BITRATE };
    if (meta.current.mime) opts.mimeType = meta.current.mime;
    const rec = new MediaRecorder(s, opts);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    segments.current.push(
      new Promise((resolve) => {
        rec.onstop = () => {
          const type = (rec.mimeType || meta.current.mime || "audio/webm").split(";")[0];
          resolve(chunks.length ? upload(new Blob(chunks, { type }), index) : Promise.resolve({ ok: true, text: "" }));
        };
      })
    );
    rec.start();
    recorder.current = rec;
    timers.current.roll = setTimeout(() => {
      if (recorder.current === rec && rec.state === "recording") {
        rec.stop();
        startSegment();
      }
    }, SEGMENT_MS);
  }

  async function start() {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Recording isn't supported in this browser — please type the note.");
      return;
    }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
    } catch {
      setError("Microphone permission denied. Allow the mic for this site and try again.");
      return;
    }
    meta.current = { id: onStart(), startedAt: Date.now(), mime: pickMime() };
    segments.current = [];
    try {
      // Keep the screen on while recording (iOS stops recording when it locks).
      const wl = (navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock;
      wakeLock.current = (await wl?.request("screen")) ?? null;
    } catch {
      /* not supported: the UI asks to keep the screen on */
    }
    setElapsed(0);
    setState("recording");
    startSegment();
    timers.current.tick = setInterval(() => {
      const ms = Date.now() - meta.current.startedAt;
      setElapsed(ms);
      if (ms >= MAX_MS) void stop();
    }, 250);
  }

  async function stop() {
    if (!recorder.current) return;
    clearInterval(timers.current.tick);
    clearTimeout(timers.current.roll);
    const durationMs = Date.now() - meta.current.startedAt;
    const rec = recorder.current;
    recorder.current = null;
    setState("finishing");
    if (rec.state === "recording") rec.stop();
    const results = await Promise.all(segments.current);
    cleanup();
    setState("idle");

    const failed = results.filter((r) => !r.ok).length;
    const transcript = results
      .map((r) => r.text)
      .filter(Boolean)
      .join(" ")
      .trim();
    if (failed) setError(`${failed} part${failed > 1 ? "s" : ""} of the recording couldn't be turned into text — please type the missing bit.`);
    else if (!transcript) setError("Didn't catch anything — try again a little closer to the phone.");
    onResult({
      transcript,
      audio: {
        mime: (meta.current.mime || "audio/webm").split(";")[0],
        segments: results.length,
        durationMs,
        sttModel: results.find((r) => r.model)?.model ?? "saaras:v4",
      },
      failedSegments: failed,
    });
  }

  return (
    <div className="voice">
      {state === "idle" && (
        <button type="button" className="mic" disabled={disabled} onClick={start}>
          <span aria-hidden>🎤</span> Bolo / Speak
        </button>
      )}
      {state === "recording" && (
        <>
          <button type="button" className="mic recording" onClick={stop}>
            <span className="rec-dot" aria-hidden /> Stop · {fmt(elapsed)}
          </button>
          <p className="muted small">
            Max {fmt(MAX_MS)}. Screen on rakhein / keep the screen on.
          </p>
        </>
      )}
      {state === "finishing" && (
        <button type="button" className="mic" disabled>
          Likh rahe hain… / Writing it down…
        </button>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
