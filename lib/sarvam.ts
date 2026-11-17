import { audioExtension, baseMime } from "./audio";

// Sarvam speech-to-text (adapted from Pyrock's lib/sarvam.ts).
//
// Settings chosen from a probe on 2026-11-17 (synthetic Hinglish note with
// five invented brand/doctor names):
//   saaras:v4 + mode "codemix" + keyterms  -> 5/5 names right, Latin script
//   saaras:v4 codemix without keyterms     -> 2/5
//   saaras:v3 codemix (Pyrock)             -> 0/5 (keyterms: v4 only)
// The synchronous REST API takes at most 30 s of audio, so the browser
// records in ~25 s segments and each is transcribed separately.

export const STT_MODEL = "saaras:v4";
export const MAX_KEYTERMS = 50;
const KEYTERM_MAX_LEN = 64;
const TIMEOUT_MS = 25_000;

export class SarvamError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "SarvamError";
  }
}

export interface Transcription {
  transcript: string;
  languageCode: string | null;
  model: string;
}

/** Keyterms as Sarvam accepts them: unique, non-empty, ≤64 chars, at most 50. */
export function cleanKeyterms(terms: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of terms) {
    const t = raw.trim().replace(/\s+/g, " ");
    if (!t || t.length > KEYTERM_MAX_LEN || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length === MAX_KEYTERMS) break;
  }
  return out;
}

export function buildSttForm(audio: Uint8Array, mime: string, keyterms: string[]): FormData {
  const form = new FormData();
  // Sarvam matches the part's Content-Type exactly: no ";codecs=..." parameter.
  const type = baseMime(mime);
  form.append("file", new Blob([audio as Uint8Array<ArrayBuffer>], { type }), `segment.${audioExtension(type)}`);
  form.append("model", STT_MODEL);
  form.append("mode", "codemix"); // English words (brands) stay in Latin script
  form.append("language_code", "unknown");
  const terms = cleanKeyterms(keyterms);
  if (terms.length) form.append("keyterms", JSON.stringify(terms));
  return form;
}

export async function transcribe(audio: Uint8Array, mime: string, keyterms: string[], fetchImpl: typeof fetch = fetch): Promise<Transcription> {
  const key = process.env.SARVAM_API_KEY;
  if (!key) throw new SarvamError("SARVAM_API_KEY is not set");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl("https://api.sarvam.ai/speech-to-text", {
      method: "POST",
      headers: { "api-subscription-key": key },
      body: buildSttForm(audio, mime, keyterms),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new SarvamError(`Speech-to-text failed (${res.status}): ${text.slice(0, 200)}`, res.status);
    const json = JSON.parse(text) as { transcript?: unknown; language_code?: unknown };
    if (typeof json.transcript !== "string") throw new SarvamError("Speech-to-text response had no transcript");
    return {
      transcript: json.transcript.trim(),
      languageCode: typeof json.language_code === "string" ? json.language_code : null,
      model: STT_MODEL,
    };
  } catch (err) {
    if (err instanceof SarvamError) throw err;
    if (err instanceof Error && err.name === "AbortError") throw new SarvamError(`Speech-to-text timed out after ${TIMEOUT_MS / 1000}s`);
    throw new SarvamError(err instanceof Error ? err.message : "Speech-to-text network error");
  } finally {
    clearTimeout(timer);
  }
}
