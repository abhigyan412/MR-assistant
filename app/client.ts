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
}

export interface Message {
  id: string;
  text: string;
  status: "RECEIVED" | "PROCESSED" | "NEEDS_REVIEW" | "FAILED" | "DISCARDED";
  errorReason: string | null;
  adverseEventFlag: boolean;
  recordedAt: string;
  createdAt: string;
  reviewItems: ReviewItem[];
  _count?: { events: number };
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

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

const post = <T>(url: string, body: unknown) => call<T>(url, { method: "POST", body: JSON.stringify(body) });

export const api = {
  users: () => call<Person[]>("/api/users"),
  messages: (mrId: string) => call<Message[]>(`/api/messages?mrId=${encodeURIComponent(mrId)}`),
  sendNote: (body: { messageId: string; mrId: string; text: string; recordedAt: string }) =>
    post<{ message: Message; isDuplicate: boolean }>("/api/messages", body),
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

export function newId(): string {
  return crypto.randomUUID();
}
