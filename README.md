# MR Assistant

Turns short Hinglish voice/text notes from pharma Medical Representatives into
a structured Daily Call Report (DCR), sample stock, doctor history and
follow-ups. Adapted from Pyrock AI (construction inventory), keeping its core
rule: **the LLM only extracts; deterministic code validates and computes.**

See [ARCHITECTURE.md](ARCHITECTURE.md) for the data model, pipeline and decisions.

## Phase status

| Phase | Scope | Status |
|---|---|---|
| 0 | Schema, seed data (incl. opening stock), swappable LLM adapter, eval set + runner | done — **baseline eval pending API key** |
| 1 | Text note → events → name matching → MR confirm cards → DCR + sample stock; manager queue; admin receipts | done — **not yet run against a real LLM** |
| 2 | Voice (Sarvam), audio storage, brand-name STT eval | not started |
| 3 | Doctor history, follow-up list, manager dashboard | not started |
| 4 | Auth, tenant enforcement, WhatsApp | not started |

## Setup

Requires Node 20+, a Postgres database (its own Neon project — not Pyrock's),
and an Anthropic API key.

```bash
npm install
cp .env.example .env        # fill in DATABASE_URL and ANTHROPIC_API_KEY
npx prisma migrate dev      # creates tables
npx prisma db seed          # demo company, MRs, doctors, products, opening stock (re-runnable)
npm run dev                 # http://localhost:3000
```

The UI has three tabs (no login until Phase 4 — pick who you are):

- **MR** — type a note, answer review cards in one tap, see today's DCR and sample stock.
  "Resend last" re-sends the previous note with the same id to show nothing is counted twice.
- **Manager** — adverse-event cards, MR-added doctors to approve, MR cards still open.
- **Admin** — log samples sent to an MR (stock-in).

## Tests

```bash
npm test                    # unit tests: dates, events, matching, interpret, scorer, adapter
```

Database integration tests (the real pipeline against Postgres, with a scripted
LLM) run when `TEST_DATABASE_URL` is set. A throwaway local database works:

```bash
docker run -d --name mr-assistant-testdb -e POSTGRES_PASSWORD=testpw -e POSTGRES_DB=mr_test -p 55432:5432 postgres:16
DATABASE_URL=postgresql://postgres:testpw@localhost:55432/mr_test npx prisma migrate deploy
TEST_DATABASE_URL=postgresql://postgres:testpw@localhost:55432/mr_test npm test
```

On a machine with little free RAM, add `--no-file-parallelism --maxWorkers=1`
to the test command; `next build` may need `experimental: { cpus: 1 }`.

## Eval

```bash
npm run eval                                   # default model (LLM_MODEL)
npm run eval -- --models claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5
npm run eval -- --cases N04,N05 --effort low
```

- Cases live in [eval/cases.ts](eval/cases.ts). All are **invented** until the
  domain partner supplies real notes — replace in place and set `source: "partner"`.
- The eval needs only `ANTHROPIC_API_KEY`; it builds the MR shortlist from
  [prisma/seed-data.ts](prisma/seed-data.ts), not the database.
- Two scores per model:
  - **extraction** — did the LLM output the right doctors, products, quantities,
    units, dates, flags, and nothing it shouldn't (patient data, guesses);
  - **pipeline outcome** — after the deterministic checks (matching, units,
    stock), is the final status and set of review cards what we expect.
- A **critical** failure = an error that would corrupt the compliance record
  if processed (wrong/guessed doctor or product, wrong or guessed quantity or
  unit, invented visit, patient data in the output). Target: zero.
- Voice cases (V1–V5) are scripts to record into `eval/audio/<id>.webm`;
  skipped until recorded and until Phase 2 adds transcription.
- Full results (including model output) are written to `eval/results/` (gitignored).

## Open TODOs

- **Before any real pilot:** mask patient names in `Message.text`,
  `transcript` and audio, or apply a retention limit. Raw text is kept as-is
  for the demo only.
- `"next week"` = +7 days is provisional, pending partner confirmation
  (see `PENDING_RULES` in [lib/dates.ts](lib/dates.ts)); the DCR marks such dates.
- Rejecting an MR-added doctor does not yet reverse events already logged
  against them (Phase 3).
- Two notes for the same product processed at the exact same moment could
  both pass the stock check; acceptable at demo scale.
