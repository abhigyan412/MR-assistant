// Typed fetch wrappers + plain DTOs for the UI (not Prisma types: dates arrive as strings).

export interface Person {
  id: string;
  name: string;
  role: "MR" | "ABM" | "RBM" | "ADMIN";
  territory: { name: string } | null;
}

export interface Candidate {
  id: string;
  label: string;
  score: number;
}

export interface ReviewItem {
  id: string;
  messageId: string;
  kind: string;
  path: string | null;
  rawMention: string | null;
  candidates: Candidate[] | null;
  assignee: "MR" | "MANAGER";
  detail: string | null;
  blocking: boolean;
  status: "OPEN" | "RESOLVED" | "DISMISSED";
  resolution?: { action?: string } | null;
  proposal?: { direction: "received" | "out"; productId: string; productName: string; quantity: number; unit: string; baseQuantity: number; reason: string | null } | null;
}

export interface Message {
  id: string;
  text: string;
  status: "RECEIVED" | "PROCESSED" | "NEEDS_REVIEW" | "FAILED" | "DISCARDED";
  errorReason: string | null;
  adverseEventFlag: boolean;
  recordedAt: string;
  createdAt: string;
  attempts: number;
  lastAttemptAt: string;
  channel: "WEB_TEXT" | "WEB_VOICE" | "WHATSAPP" | "ADMIN";
  transcript: string | null; // raw speech-to-text, never edited
  audioKey: string | null;
  audioSegments: number | null;
  audioDurationMs: number | null;
  reviewItems: ReviewItem[];
  _count?: { events: number };
}

/** What the MR submits for one note. Voice notes add the raw transcript + audio info. */
export interface NoteBody {
  messageId: string;
  text: string;
  recordedAt: string;
  transcript?: string;
  audio?: { mime: string; segments: number; durationMs: number; sttModel: string };
}

export interface Catalog {
  doctors: { id: string; name: string; specialty: string | null; area: string | null }[];
  products: { id: string; brandName: string; baseUnit: string; units: { unit: string; toBase: number }[] }[];
  managers: { id: string; name: string; role: string }[];
}

export interface DcrVisit {
  visitId: string;
  doctor: { id: string | null; name: string; specialty: string | null; area: string | null; pendingApproval: boolean };
  met: boolean;
  time: string | null;
  detailed: string[];
  samples: { product: string; quantity: number; unit: string; baseUnits: number }[];
  pobs: { product: string; quantity: number; unit: string; chemist: string | null }[];
  jointWork: string[];
  queries: { question: string; product: string | null }[];
  followUps: { action: string; dueDate: string | null; provisionalRule: boolean }[];
}

export interface Dcr {
  date: string;
  summary: { visits: number; met: number; missed: number; samplesGivenBaseUnits: number; jointWorkVisits: number };
  visits: DcrVisit[];
  chemistCalls: { chemist: string; pobs: { product: string; quantity: number; unit: string }[] }[];
}

export interface StockRow {
  productId: string;
  brandName: string;
  baseUnit: string;
  balance: number;
}

export interface ManagerQueue {
  managerItems: (ReviewItem & { mrName?: string; message: { text: string; recordedAt: string } })[];
  mrItemsOpen: (ReviewItem & { mrName?: string; message: { text: string; recordedAt: string } })[];
  pendingDoctors: { id: string; name: string; specialty: string | null; area: string | null; addedBy: string | null }[];
}

/** Thrown when the request never got an answer (offline, slow network, timeout). */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

// Longer than the server's LLM timeout + DB work, shorter than "MR gives up".
const REQUEST_TIMEOUT_MS = 75_000;

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (err) {
    throw new NetworkError(
      err instanceof DOMException && err.name === "AbortError" ? "No answer from the server (timed out)" : "No connection"
    );
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

const post = <T>(url: string, body: unknown) => call<T>(url, { method: "POST", body: JSON.stringify(body) });

export const api = {
  users: () => call<Person[]>("/api/users"),
  messages: (mrId: string) => call<Message[]>(`/api/messages?mrId=${encodeURIComponent(mrId)}`),
  sendNote: (body: NoteBody & { mrId: string }) =>
    post<{ message: Message; isDuplicate: boolean }>("/api/messages", body),
  transcribe: async (p: { audio: Blob; messageId: string; segment: number; mrId: string }) => {
    const form = new FormData();
    form.append("audio", p.audio, `segment.${p.audio.type.includes("mp4") ? "m4a" : "webm"}`);
    form.append("messageId", p.messageId);
    form.append("segment", String(p.segment));
    form.append("mrId", p.mrId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 40_000);
    try {
      const res = await fetch("/api/voice/transcribe", { method: "POST", body: form, signal: controller.signal });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error ?? `Transcription failed (${res.status})`);
      return data as { segment: number; transcript: string; model: string; stored: boolean };
    } finally {
      clearTimeout(timer);
    }
  },
  audioUrls: (messageId: string) => call<{ urls: string[] }>(`/api/messages/${encodeURIComponent(messageId)}/audio`),
  retry: (messageId: string) => post<Message>(`/api/messages/${encodeURIComponent(messageId)}/retry`, {}),
  recheck: (messageId: string) => post<Message>(`/api/messages/${encodeURIComponent(messageId)}/recheck`, {}),
  resolve: (itemId: string, actorId: string, resolution: unknown) =>
    post<Message>(`/api/review-items/${encodeURIComponent(itemId)}/resolve`, { actorId, resolution }),
  dcr: (mrId: string, date: string) => call<Dcr>(`/api/mrs/${encodeURIComponent(mrId)}/dcr?date=${date}`),
  stock: (mrId: string) => call<StockRow[]>(`/api/mrs/${encodeURIComponent(mrId)}/stock`),
  catalog: (mrId: string) => call<Catalog>(`/api/mrs/${encodeURIComponent(mrId)}/catalog`),
  queue: (managerId: string) => call<ManagerQueue>(`/api/managers/${encodeURIComponent(managerId)}/queue`),
  decideDoctor: (doctorId: string, actorId: string, approve: boolean) =>
    post(`/api/doctors/${encodeURIComponent(doctorId)}/decision`, { actorId, approve }),
  addReceipt: (body: { entryId: string; adminId: string; mrId: string; productId: string; quantity: number; unit: string; note: string | null }) =>
    post<{ duplicate: boolean }>("/api/admin/sample-receipts", body),
};

/** Today's calendar date in IST (YYYY-MM-DD), regardless of the browser's timezone. */
export function todayIst(): string {
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
}

/** Same window as the server's STALE_PROCESSING_MS: after this a RECEIVED note may be retried. */
export const STALE_PROCESSING_MS = 2 * 60_000;

export function newId(): string {
  return crypto.randomUUID();
}
