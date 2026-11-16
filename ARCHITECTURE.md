# Architecture — MR Assistant

## Principles (carried over from Pyrock)

1. **LLM only extracts; code validates and computes.** The model classifies
   and copies (which doctor, which product, the quantity and unit as said,
   "next week"). Code does dates, unit conversion, stock and IDs.
2. **Unsure → review, never a silent guess.** Ambiguous names, missing
   quantities or unknown units become one-tap review cards for the MR.
   A unit that wasn't said is filled in only when the product master leaves
   no choice (one unit: `baseUnit`, no `ProductUnit` rows); otherwise
   `UNIT_UNKNOWN`.
3. **Idempotency.** `Message.id` is generated on the device when recording
   starts and is the primary key; a resend is a no-op.
4. **Audit trail.** Raw note/transcript → `Message.extraction` (validated LLM
   output) → `ReviewItem` resolutions → `Event` ledger. Every event has a
   source message, including admin entries.

## Stack

Next.js 14 (App Router) + TypeScript · Postgres (Neon) via Prisma · Zod ·
Anthropic SDK (structured outputs) behind a provider interface · Sarvam STT
(Phase 2) · Vitest · Vercel.

## Pipeline

```
note (text / transcript) + client message id                 [lib/pipeline.ts]
  │
  ├─ 1. INSERT Message (PK = message id) ── duplicate? return stored result
  ├─ 2. extractNote(): LLM with MR shortlist → Zod-validated Extraction,
  │       unknown refs nulled                                [lib/extract.ts]
  ├─ 3. interpret(): pure function, no DB/LLM                [lib/interpret.ts]
  │       names (lib/matching.ts), dates (IST), units from ProductUnit,
  │       stock never below zero, same-doctor-same-day, corrections, AE flag
  ├─ 4. any doubt → ReviewItems (MR first) → NEEDS_REVIEW, no events
  └─ 5. all clear → write Events in one transaction → PROCESSED
```

Provider errors, refusals and schema failures → `FAILED` (retryable).
Each review answer ([lib/review.ts](lib/review.ts)) is stored as a resolution
on its item, then step 3–5 re-run with all resolutions applied. Picking a
doctor/product also saves a per-MR alias, so the same words resolve by
themselves next time.

### Name matching ([lib/matching.ts](lib/matching.ts))

Accept only when two signals agree or one is strong and unambiguous:

| Situation | Result |
|---|---|
| Learned alias for this MR | match |
| Surname unique in the MR's territory, with or without an honorific ("Iyer madam") | match |
| Brand prefix unique in the product list ("Ostiva" → Ostiva-D3); shared prefix ("Telmora") asks | match |
| Strong fuzzy/phonetic match (≥ 0.85, clear margin), LLM agrees or abstains | match |
| One plausible candidate (≥ 0.7) and the LLM picked it | match |
| Several candidates; LLM picked one AND its evidence words ("cardio wale") fit only that doctor | match |
| LLM picked something no spelling supports (e.g. competitor "Telma") | one-tap confirm |
| Several candidates otherwise | `*_AMBIGUOUS` card |
| Nothing close | `*_NOT_FOUND` card (doctors: add as new → manager approves) |

Spelling similarity is phonetic: Devanagari is transliterated first
("कफज़ेन" → "kaphazen"), Indian-English sound-alikes are folded (ough→af,
ai→e, q→k, z→j…), and a consonant skeleton is compared at a 0.9 discount, so
"Kafzen syrup" and "डॉ. कुरैशी" resolve while a skeleton-only match never
outranks a real spelling match.

Managers are matched by role word (ABM/RBM) or name only; "sir saath the"
with two managers is always `MANAGER_AMBIGUOUS`.

### Review cards

| Kind | Answers | Blocks DCR |
|---|---|---|
| DOCTOR_AMBIGUOUS / DOCTOR_NOT_FOUND | pick · add new doctor · discard | yes |
| PRODUCT_AMBIGUOUS / PRODUCT_NOT_FOUND | pick · not ours (skip) | yes |
| MANAGER_AMBIGUOUS | pick · nobody | yes |
| QUANTITY_MISSING / UNIT_UNKNOWN / STOCK_INSUFFICIENT | quantity + unit · skip item · (stock) recheck | yes |
| LOW_CONFIDENCE (only when the note has no other card and no answers yet) | looks right · discard | yes |
| VISIT_STATUS_CONFLICT (met=false but products detailed / samples / POB) | yes, met · no, not available (drops the products) · discard | yes |
| POSSIBLE_DUPLICATE_VISIT | same visit (discard note) · second visit | yes |
| CORRECTION_REQUESTED | replace selected earlier entries · not a correction | yes |
| ADVERSE_EVENT (manager) | acknowledge | **no** |

A confirmed correction writes reversing events for the chosen entries and
attaches the corrected facts to the original visit (no second visit in the DCR).

## API (no auth until Phase 4)

| Endpoint | Purpose |
|---|---|
| `POST /api/messages` | submit a note `{messageId, mrId, text, recordedAt?}`; idempotent |
| `GET /api/messages?mrId=` | recent notes with status and cards |
| `POST /api/messages/:id/recheck` | re-run checks (e.g. after a stock receipt), no LLM |
| `POST /api/review-items/:id/resolve` | answer a card `{actorId, resolution}` |
| `GET /api/mrs/:mrId/dcr?date=` | DCR for an IST date |
| `GET /api/mrs/:mrId/stock` | sample stock |
| `GET /api/mrs/:mrId/catalog` | MR's doctors / products / managers |
| `GET /api/managers/:id/queue` | AE cards, doctors to approve, MR cards still open |
| `POST /api/doctors/:id/decision` | approve / reject an MR-added doctor |
| `POST /api/admin/sample-receipts` | admin stock-in; idempotent on `entryId` |
| `GET /api/users` | demo person picker |

## Data model

See [prisma/schema.prisma](prisma/schema.prisma). Key decisions:

| Decision | Why |
|---|---|
| `companyId` on every table, not enforced until Phase 4 | No backfill migration later. |
| `Event.type` is a string + per-type Zod payload ([lib/events.ts](lib/events.ts)) | Changing fields after the partner demo is a code change, not a migration. Only columns used for joins/sums (doctor, product, chemist, manager, visit, stockDelta, dates) are real columns. |
| Events written **only when final** | Proposed events live in `Message.extraction` + `ReviewItem`. Sample stock is a plain `SUM(stockDelta)` with no status filter. |
| Corrections = reversing events (`reversesEventId @unique`) | Never edit history; an event can be reversed once. |
| `occurredOn` = IST calendar date string | DCR grouping without timezone bugs. |
| `sample_received` is admin-only; opening stock is seeded as `sample_received` | Stock has exactly one formula. A `sample_given` that would go negative → `STOCK_INSUFFICIENT` review, never negative stock. |
| Adverse-event mentions → message flag + manager review item | Pharmacovigilance; summary carries no patient identifiers. |
| RCPA later = new event type; tour plan later = new `TourPlan` table | No rewrite needed. |

## Derived views (no tables)

- **DCR**: one row per un-reversed `doctor_visit` for an MR and `occurredOn`,
  with child events via `visitEventId`; `met: false` shows as missed.
  Chemist POBs without a visit go under "Chemist calls".
- **Sample stock**: `SUM(stockDelta)` by MR and product.
- **Open follow-ups**: `follow_up` events with no later visit to that doctor.

## LLM layer

- [lib/llm/types.ts](lib/llm/types.ts) — provider interface + typed errors.
- [lib/llm/anthropic.ts](lib/llm/anthropic.ts) — `client.beta.messages.parse`
  with a Zod structured-output format, explicit `effort`, prompt caching on the
  system prompt + MR shortlist, and server-side refusal fallbacks
  (`fallbacks: "default"`) on models that support them.
- [lib/llm/index.ts](lib/llm/index.ts) — `createProvider()` from
  `LLM_PROVIDER` / `LLM_MODEL` / `LLM_EFFORT`. Adding a provider = one file + one case.
- [lib/prompts.ts](lib/prompts.ts) — `PROMPT_VERSION` is stored on each
  message and eval result.
- The LLM sees short refs (D3, P2, M1, C1) for the MR's territory only, never
  database ids. Unknown refs are nulled, not trusted.

## Dates

All date rules are in [lib/dates.ts](lib/dates.ts), computed in Asia/Kolkata
(fixed +05:30; India has no DST). The LLM returns `dayOffset` for the visit
and a classified `due` for follow-ups; it never returns a date.
