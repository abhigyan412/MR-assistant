// MR Assistant eval set. Every note here is INVENTED (source: "invented")
// until the domain partner supplies real ones — replace in place and set
// source: "partner".
//
// Two layers of expectations:
// - `expect`   — what the LLM extraction must contain. Scored from Phase 0.
// - `pipeline` — final status / review items after deterministic code runs.
//                Scored from Phase 1 (the pipeline doesn't exist yet).
//
// Conventions in `expect`:
// - Doctors/products/managers/chemists are referenced by seed code.
// - { ambiguous: [...] } = the model must NOT pick (ref null); these are the
//   candidates the Phase 1 confirm card should offer.
// - { newDoctor: "..." } = not in the shortlist; ref null, mention contains it.
// - A list field left undefined means "must be empty". "any" = not scored.
// - All notes recorded Wednesday 18 Nov 2026, 11:00 IST, by MR Rohit Kumar
//   (South Delhi) unless stated otherwise.

export type Code = string;
export type Ambiguous = { ambiguous: Code[] };
export type DoctorExpect = Code | Ambiguous | { newDoctor: string };
export type ProductExpect = Code | Ambiguous;
type AnyOr<T> = T | "any";

export interface VisitExpect {
  doctor: DoctorExpect;
  met?: boolean; // default true
  dayOffset?: AnyOr<number>; // default 0
  jointWork?: AnyOr<(Code | Ambiguous)[]>;
  detailed?: AnyOr<ProductExpect[]>;
  samples?: AnyOr<{ product: ProductExpect; quantity: number | null; unit: string | null }[]>;
  queries?: AnyOr<{ product: Code | null }[]>;
  followUps?: AnyOr<{ due: string | null }[]>; // resolved IST date
  pobs?: AnyOr<{ product: ProductExpect; quantity: number | null; unit: string | null; chemist?: Code | null }[]>;
}

export interface ChemistCallExpect {
  chemist: Code;
  pobs: { product: ProductExpect; quantity: number | null; unit: string | null }[];
}

export interface EvalCase {
  id: string;
  kind: "text" | "voice";
  note: string; // for voice: the script to record
  audioFile?: string; // voice: path to the recording once it exists
  recordedAt?: string; // ISO with offset; default DEFAULT_RECORDED_AT
  mr?: string; // default MR-ROHIT
  source: "invented" | "partner";
  covers: string[];
  // Phase 1 only (no LLM-level expectation), e.g. the resent duplicate.
  pipelineOnly?: boolean;
  expect?: {
    visits: VisitExpect[];
    chemistCalls?: ChemistCallExpect[];
    adverseEvent?: boolean; // default false
    correction?: boolean; // default false
    forbidden?: string[]; // regexes that must not appear anywhere in the output (patient data)
  };
  pipeline: {
    status: "PROCESSED" | "NEEDS_REVIEW" | "FAILED" | "DUPLICATE";
    reviewKinds?: string[];
    note?: string;
  };
}

export const DEFAULT_RECORDED_AT = "2026-11-18T11:00:00+05:30";
export const DEFAULT_MR = "MR-ROHIT";

// Seed codes, named for readability.
const VERMA = "DR-001",
  R_SHARMA = "DR-002",
  S_SHARMA = "DR-003",
  IYER = "DR-004",
  QURESHI = "DR-005",
  BEDI = "DR-006",
  P_GUPTA = "DR-007",
  A_GUPTA = "DR-008",
  MEHTA = "DR-012";
const ZEN = "PRD-ZEN40",
  GLY = "PRD-GLYM2",
  TEL40 = "PRD-TEL40",
  TELH = "PRD-TELH",
  OST = "PRD-OSTD3",
  COUGH = "PRD-COUGH",
  FER = "PRD-FERXT",
  CALZ = "PRD-CALZ";
const SANJAY = "ABM-DELHI",
  NEERAJ = "RBM-NORTH";
const SAKET_MED = "CH-001",
  VERMA_MED = "CH-002";

export const CASES: EvalCase[] = [
  {
    id: "N01",
    kind: "text",
    source: "invented",
    covers: ["doctor_visit", "product_detailed", "sample_given", "doctor_query", "follow_up", "next-week rule (pending)"],
    note: "Dr. Verma ko Zentapra detail kiya, 3 strips sample diye, unhone elderly dose pucha, next week follow up",
    expect: {
      visits: [
        {
          doctor: VERMA,
          detailed: [ZEN],
          samples: [{ product: ZEN, quantity: 3, unit: "strip" }],
          queries: [{ product: ZEN }],
          followUps: [{ due: "2026-11-25" }],
        },
      ],
    },
    pipeline: { status: "PROCESSED" },
  },
  {
    id: "N02",
    kind: "text",
    source: "invented",
    covers: ["multiple products", "'each'", "pob (doctor, via chemist)"],
    note: "Met Dr Pooja Gupta saket. Detailed Telmora 40 n Glyconix M2, gave 2 strip each. 10 strip Glyconix ka POB diya, Saket Medicos se jayega",
    expect: {
      visits: [
        {
          doctor: P_GUPTA,
          detailed: [TEL40, GLY],
          samples: [
            { product: TEL40, quantity: 2, unit: "strip" },
            { product: GLY, quantity: 2, unit: "strip" },
          ],
          pobs: [{ product: GLY, quantity: 10, unit: "strip", chemist: SAKET_MED }],
        },
      ],
    },
    pipeline: { status: "PROCESSED" },
  },
  {
    id: "N03",
    kind: "text",
    source: "invented",
    covers: ["Devanagari", "late logging (kal = yesterday)"],
    note: "कल शाम डॉ. कुरैशी से मिला, कफज़ेन सिरप दिखाया, 2 बोतल सैंपल दी",
    expect: {
      visits: [
        {
          doctor: QURESHI,
          dayOffset: -1,
          detailed: [COUGH],
          samples: [{ product: COUGH, quantity: 2, unit: "bottle" }],
        },
      ],
    },
    pipeline: { status: "PROCESSED", note: "visit and sample dated 17 Nov" },
  },
  {
    id: "N04",
    kind: "text",
    source: "invented",
    covers: ["ambiguous doctor #1", "ambiguous brand family"],
    note: "Sharma ji ko Telmora detail kiya, 2 strip diye",
    expect: {
      visits: [
        {
          doctor: { ambiguous: [R_SHARMA, S_SHARMA] },
          detailed: [{ ambiguous: [TEL40, TELH] }],
          samples: [{ product: { ambiguous: [TEL40, TELH] }, quantity: 2, unit: "strip" }],
        },
      ],
    },
    pipeline: { status: "NEEDS_REVIEW", reviewKinds: ["DOCTOR_AMBIGUOUS", "PRODUCT_AMBIGUOUS"] },
  },
  {
    id: "N05",
    kind: "text",
    source: "invented",
    covers: ["ambiguous doctor #2", "unknown unit (no box for Ferovia)"],
    note: "dr gupta ke clinic gaya, ferovia xt ka 1 box diya",
    expect: {
      visits: [
        {
          doctor: { ambiguous: [P_GUPTA, A_GUPTA] },
          detailed: "any",
          samples: [{ product: FER, quantity: 1, unit: "box" }],
        },
      ],
    },
    pipeline: { status: "NEEDS_REVIEW", reviewKinds: ["DOCTOR_AMBIGUOUS", "UNIT_UNKNOWN"] },
  },
  {
    id: "N06",
    kind: "text",
    source: "invented",
    covers: ["name made clear by context", "doctor_query"],
    note: "Sharma sir (cardio wale) ko Telmora H ki detailing, unhone pucha BP ke saath diabetes wale patients mein de sakte hai kya",
    expect: {
      visits: [{ doctor: R_SHARMA, detailed: [TELH], queries: [{ product: TELH }] }],
    },
    pipeline: { status: "PROCESSED" },
  },
  {
    id: "N07",
    kind: "text",
    source: "invented",
    covers: ["missing quantity", "follow_up in days"],
    note: "Iyer madam ko Ferovia ke samples diye, 15 din baad dobara milna hai",
    expect: {
      visits: [
        {
          doctor: IYER,
          detailed: "any",
          samples: [{ product: FER, quantity: null, unit: null }],
          followUps: [{ due: "2026-12-03" }],
        },
      ],
    },
    pipeline: { status: "NEEDS_REVIEW", reviewKinds: ["QUANTITY_MISSING"] },
  },
  {
    id: "N08",
    kind: "text",
    source: "invented",
    covers: ["patient #1 (name + age)", "doctor_query"],
    note: "Dr Iyer ne apni patient Sunita, 32 saal, ke liye pucha ki pregnancy mein Ostiva D3 safe hai kya. 4 sachet diye",
    expect: {
      visits: [
        {
          doctor: IYER,
          detailed: "any",
          samples: [{ product: OST, quantity: 4, unit: "sachet" }],
          queries: [{ product: OST }],
        },
      ],
      forbidden: ["Sunita", "\\b32\\b"],
    },
    pipeline: { status: "PROCESSED" },
  },
  {
    id: "N09",
    kind: "text",
    source: "invented",
    covers: ["patient #2 (name + age)", "adverse event"],
    note: "Qureshi sir bole ek bacche Aarav (5 saal) ko Coughzen se rash ho gaya, company se safety data mangwaya hai",
    expect: {
      visits: [{ doctor: QURESHI, detailed: "any", queries: [{ product: COUGH }], followUps: "any" }],
      adverseEvent: true,
      forbidden: ["Aarav", "\\b5[- ]?(saal|year|yr)"],
    },
    pipeline: { status: "PROCESSED", reviewKinds: ["ADVERSE_EVENT"], note: "AE item routed to manager" },
  },
  {
    id: "N10",
    kind: "text",
    source: "invented",
    covers: ["patient #3 (name + reading)", "box -> strip conversion"],
    note: "Pooja Gupta mam ne bataya unke patient Mr Khanna (BP 180) ko Telmora 40 se fayda hua, 1 box sample diya",
    expect: {
      visits: [{ doctor: P_GUPTA, detailed: "any", samples: [{ product: TEL40, quantity: 1, unit: "box" }] }],
      forbidden: ["Khanna", "\\b180\\b"],
    },
    pipeline: { status: "PROCESSED", note: "stockDelta -10 strips (1 box x 10)" },
  },
  {
    id: "N11",
    kind: "text",
    source: "invented",
    covers: ["joint_work (by role)", "no sample given"],
    note: "aaj RBM sir saath the. Verma sir busy the, bas Zentapra aur Glyconix ka reminder diya, sample nahi diya",
    expect: {
      visits: [{ doctor: VERMA, jointWork: [NEERAJ], detailed: [ZEN, GLY] }],
    },
    pipeline: { status: "PROCESSED" },
  },
  {
    id: "N12",
    kind: "text",
    source: "invented",
    covers: ["new doctor (not Dr. Deepak Arora)"],
    note: "naye doctor mile Dr Ritu Arora, skin specialist, Kalkaji. Ostiva detail kiya",
    expect: {
      visits: [{ doctor: { newDoctor: "Ritu Arora" }, detailed: [OST] }],
    },
    pipeline: { status: "NEEDS_REVIEW", reviewKinds: ["DOCTOR_NOT_FOUND"] },
  },
  {
    id: "N13",
    kind: "text",
    source: "invented",
    covers: ["correction"],
    note: "pichle note mein galti, Dr Verma ko 3 nahi 2 strip Zentapra diye the",
    expect: {
      visits: [
        { doctor: VERMA, dayOffset: "any", detailed: "any", samples: [{ product: ZEN, quantity: 2, unit: "strip" }] },
      ],
      correction: true,
    },
    pipeline: {
      status: "NEEDS_REVIEW",
      reviewKinds: ["CORRECTION_REQUESTED"],
      note: "must NOT auto-add -2 on top of N01's -3; on confirm: reversal +3, new sample -2",
    },
  },
  {
    id: "N14",
    kind: "text",
    source: "invented",
    covers: ["resent duplicate (same message ID)"],
    pipelineOnly: true,
    note: "Dr. Verma ko Zentapra detail kiya, 3 strips sample diye, unhone elderly dose pucha, next week follow up",
    pipeline: {
      status: "DUPLICATE",
      note: "N01 resent with the same message ID: return the stored result, no LLM call, stock unchanged",
    },
  },
  {
    id: "N15",
    kind: "text",
    source: "invented",
    covers: ["no events (MR's own plans)"],
    note: "aaj traffic bahut tha, sirf 2 call hui, kal Saket cover karunga",
    expect: { visits: [] },
    pipeline: { status: "PROCESSED", note: "zero events" },
  },
  {
    id: "N16",
    kind: "text",
    source: "invented",
    covers: ["competitor brand (Telma) not matched"],
    note: "Dr Bedi Telma likhte hain, humne Telmora 40 detail kiya",
    expect: { visits: [{ doctor: BEDI, detailed: [TEL40] }] },
    pipeline: { status: "PROCESSED" },
  },
  {
    id: "N17",
    kind: "text",
    source: "invented",
    covers: ["doctor not met"],
    note: "Dr Bedi available nahi the, clinic band tha",
    expect: { visits: [{ doctor: BEDI, met: false }] },
    pipeline: { status: "PROCESSED", note: "shown in DCR as missed" },
  },
  {
    id: "N18",
    kind: "text",
    source: "invented",
    covers: ["3 visits in one note", "events attach to the right visit"],
    note: "Aaj 3 doctors cover kiye. Pehle Verma sir - Zentapra detail kiya, 2 strip diye. Phir Bedi sir ko Ostiva ke 4 sachet. Last mein Iyer madam ko Ferovia 3 strip aur Ostiva 2 sachet diye, Ferovia detail bhi kiya",
    expect: {
      visits: [
        { doctor: VERMA, detailed: [ZEN], samples: [{ product: ZEN, quantity: 2, unit: "strip" }] },
        { doctor: BEDI, detailed: "any", samples: [{ product: OST, quantity: 4, unit: "sachet" }] },
        {
          doctor: IYER,
          detailed: [FER],
          samples: [
            { product: FER, quantity: 3, unit: "strip" },
            { product: OST, quantity: 2, unit: "sachet" },
          ],
        },
      ],
    },
    pipeline: { status: "PROCESSED" },
  },
  {
    id: "N19",
    kind: "text",
    source: "invented",
    covers: ["stock insufficient (opening stock 6 bottles)"],
    note: "Verma sir ko Coughzen ke 10 bottle diye",
    expect: {
      visits: [{ doctor: VERMA, detailed: "any", samples: [{ product: COUGH, quantity: 10, unit: "bottle" }] }],
    },
    pipeline: { status: "NEEDS_REVIEW", reviewKinds: ["STOCK_INSUFFICIENT"] },
  },
  {
    id: "N20",
    kind: "text",
    source: "invented",
    covers: ["manager ambiguous (ABM or RBM)"],
    note: "Sir bhi saath the aaj, Dr Mehta ko Calzora detail kiya",
    expect: {
      visits: [{ doctor: MEHTA, jointWork: [{ ambiguous: [SANJAY, NEERAJ] }], detailed: [CALZ] }],
    },
    pipeline: { status: "NEEDS_REVIEW", reviewKinds: ["MANAGER_AMBIGUOUS"] },
  },
  {
    id: "N21",
    kind: "text",
    source: "invented",
    covers: ["busy but met (short call = met)"],
    note: "Bedi sir bahut busy the, 2 minute ki short call hui, bas Ostiva ka reminder diya",
    expect: {
      visits: [{ doctor: BEDI, met: true, detailed: [OST] }],
    },
    pipeline: { status: "PROCESSED", note: "a busy doctor who got a reminder was met" },
  },
  {
    id: "N22",
    kind: "text",
    source: "invented",
    covers: ["doctor absent (on leave) = not met", "follow-up on a weekday"],
    note: "Mehta sir aaj chhutti pe the, clinic pe nahi mile. Compounder ne bola Monday ko aana",
    expect: {
      visits: [{ doctor: MEHTA, met: false, followUps: [{ due: "2026-11-23" }] }],
    },
    pipeline: { status: "PROCESSED", note: "shown in DCR as missed, follow-up Monday" },
  },
  {
    id: "N23",
    kind: "text",
    source: "invented",
    covers: ["met but nothing detailed or given"],
    note: "Khan sahab se mila, sirf intro hua, aaj kuch detail nahi kiya aur sample bhi nahi diya",
    expect: {
      visits: [{ doctor: "DR-011", met: true }],
    },
    pipeline: { status: "PROCESSED", note: "a met visit with no products is valid" },
  },

  // ── Voice placeholders: record these, save to eval/audio/<id>.webm ──────
  {
    id: "V1",
    kind: "voice",
    audioFile: "eval/audio/V1.webm",
    source: "invented",
    covers: ["brand names through speech-to-text", "Telmora-H vs Telmora-40"],
    note: "Pooja Gupta madam ko Zentapra, Glyconix M2 aur Telmora H, teeno detail kiye",
    expect: { visits: [{ doctor: P_GUPTA, detailed: [ZEN, GLY, TELH] }] },
    pipeline: { status: "PROCESSED" },
  },
  {
    id: "V2",
    kind: "voice",
    audioFile: "eval/audio/V2.webm",
    source: "invented",
    covers: ["Hindi number words"],
    note: "Iyer madam ko Ostiva ke chhe sachet aur Ferovia ke paanch strip diye",
    expect: {
      visits: [
        {
          doctor: IYER,
          detailed: "any",
          samples: [
            { product: OST, quantity: 6, unit: "sachet" },
            { product: FER, quantity: 5, unit: "strip" },
          ],
        },
      ],
    },
    pipeline: { status: "PROCESSED" },
  },
  {
    id: "V3",
    kind: "voice",
    audioFile: "eval/audio/V3.webm",
    source: "invented",
    covers: ["chemist POB, no doctor visit", "chemist 'Verma' vs Dr Verma", "noisy street"],
    note: "Lajpat Nagar mein Verma Medical Store ne Zentapra ke 20 strip ka order diya",
    expect: {
      visits: [],
      chemistCalls: [{ chemist: VERMA_MED, pobs: [{ product: ZEN, quantity: 20, unit: "strip" }] }],
    },
    pipeline: { status: "PROCESSED", note: "appears under 'Chemist calls' in the DCR" },
  },
  {
    id: "V4",
    kind: "voice",
    audioFile: "eval/audio/V4.webm",
    source: "invented",
    covers: ["joint_work by name", "patient mention", "adverse event"],
    note: "Sanjay sir ke saath Qureshi sir ke paas gaye, unke ek patient ko Coughzen se bahut neend aa rahi thi, dose kam karne ka pucha",
    expect: {
      visits: [{ doctor: QURESHI, jointWork: [SANJAY], detailed: "any", queries: [{ product: COUGH }] }],
      adverseEvent: true,
    },
    pipeline: { status: "PROCESSED", reviewKinds: ["ADVERSE_EVENT"] },
  },
  {
    id: "V5",
    kind: "voice",
    audioFile: "eval/audio/V5.webm",
    source: "invented",
    covers: ["long note, 2 visits", "weekday follow-up", "future POB is not a POB"],
    note: "Pehle Verma sir ke yahan gaya, Zentapra detail kiya, 2 strip diya. Phir Bedi sir, unko Ostiva bataya, unhone bola Friday ko aana, tab POB denge",
    expect: {
      visits: [
        { doctor: VERMA, detailed: [ZEN], samples: [{ product: ZEN, quantity: 2, unit: "strip" }] },
        { doctor: BEDI, detailed: [OST], followUps: [{ due: "2026-11-20" }] },
      ],
    },
    pipeline: { status: "PROCESSED" },
  },
];
