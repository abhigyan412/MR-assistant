// Demo master data. Pure data, no DB access: used by prisma/seed.ts AND by the
// eval runner (so the eval needs only an LLM key, not a database).
//
// All companies, people, clinics and BRANDS here are fictional placeholders.
// The domain partner will replace them with real lists via CSV upload.
//
// Deliberate traps for the matcher/eval:
// - Two Dr. Sharmas and two Dr. Guptas in South Delhi (ambiguous surnames)
// - Dr. Deepak Arora exists; eval note N12 mentions a NEW Dr. Ritu Arora
// - Dr. Vikas Verma is in Rohini (other territory) — must never match "Verma"
//   for the South Delhi MR
// - Telmora-40 vs Telmora-H (brand family); "Telma" (competitor) is not ours
// - Verma Medical Store (chemist) vs Dr. Anil Verma (doctor)

export const COMPANY = { code: "DEMO", name: "Demo Pharma Pvt Ltd" };

export const TERRITORIES = [
  { code: "DL-SOUTH", name: "South Delhi HQ" },
  { code: "DL-ROHINI", name: "Rohini HQ" },
] as const;

export type SeedRole = "MR" | "ABM" | "RBM" | "ADMIN";

export interface SeedUser {
  code: string;
  name: string;
  role: SeedRole;
  territory: string | null;
  manager: string | null;
}

export const USERS: SeedUser[] = [
  { code: "RBM-NORTH", name: "Neeraj Kapoor", role: "RBM", territory: null, manager: null },
  { code: "ABM-DELHI", name: "Sanjay Malhotra", role: "ABM", territory: null, manager: "RBM-NORTH" },
  { code: "MR-ROHIT", name: "Rohit Kumar", role: "MR", territory: "DL-SOUTH", manager: "ABM-DELHI" },
  { code: "MR-PRIYA", name: "Priya Nair", role: "MR", territory: "DL-ROHINI", manager: "ABM-DELHI" },
  { code: "ADMIN-OPS", name: "Ops Admin", role: "ADMIN", territory: null, manager: null },
];

export interface SeedDoctor {
  code: string;
  name: string;
  specialty: string;
  clinic: string;
  area: string;
  territory: string;
}

export const DOCTORS: SeedDoctor[] = [
  // South Delhi
  { code: "DR-001", name: "Dr. Anil Verma", specialty: "General Physician", clinic: "Verma Clinic", area: "Lajpat Nagar", territory: "DL-SOUTH" },
  { code: "DR-002", name: "Dr. Rakesh Sharma", specialty: "Cardiologist", clinic: "Heart Care Centre", area: "Lajpat Nagar", territory: "DL-SOUTH" },
  { code: "DR-003", name: "Dr. Sunil Sharma", specialty: "Diabetologist", clinic: "Sharma Diabetes Clinic", area: "Malviya Nagar", territory: "DL-SOUTH" },
  { code: "DR-004", name: "Dr. Meena Iyer", specialty: "Gynaecologist", clinic: "Iyer Maternity Home", area: "Kalkaji", territory: "DL-SOUTH" },
  { code: "DR-005", name: "Dr. Farhan Qureshi", specialty: "Paediatrician", clinic: "Little Steps Child Clinic", area: "Okhla", territory: "DL-SOUTH" },
  { code: "DR-006", name: "Dr. Gurpreet Bedi", specialty: "General Physician", clinic: "Bedi Clinic", area: "Greater Kailash", territory: "DL-SOUTH" },
  { code: "DR-007", name: "Dr. Pooja Gupta", specialty: "Consultant Physician", clinic: "Gupta Nursing Home", area: "Saket", territory: "DL-SOUTH" },
  { code: "DR-008", name: "Dr. Alok Gupta", specialty: "Orthopaedic Surgeon", clinic: "Bone & Joint Clinic", area: "Saket", territory: "DL-SOUTH" },
  { code: "DR-009", name: "Dr. Harish Chandra", specialty: "ENT Specialist", clinic: "Chandra ENT Clinic", area: "Defence Colony", territory: "DL-SOUTH" },
  { code: "DR-010", name: "Dr. Nisha Bansal", specialty: "Dermatologist", clinic: "Skin First Clinic", area: "Saket", territory: "DL-SOUTH" },
  { code: "DR-011", name: "Dr. Mohd. Arif Khan", specialty: "General Physician", clinic: "Khan Clinic", area: "Jamia Nagar", territory: "DL-SOUTH" },
  { code: "DR-012", name: "Dr. S. K. Mehta", specialty: "Consultant Physician", clinic: "Mehta Medical Centre", area: "Hauz Khas", territory: "DL-SOUTH" },
  { code: "DR-013", name: "Dr. Kavita Rao", specialty: "Gynaecologist", clinic: "Rao Women's Clinic", area: "Vasant Kunj", territory: "DL-SOUTH" },
  { code: "DR-014", name: "Dr. Deepak Arora", specialty: "Orthopaedic Surgeon", clinic: "Arora Ortho Care", area: "Kalkaji", territory: "DL-SOUTH" },
  // Rohini (other MR's territory — must never appear in Rohit's shortlist)
  { code: "DR-101", name: "Dr. Vikas Verma", specialty: "General Physician", clinic: "Verma Health Point", area: "Rohini Sector 7", territory: "DL-ROHINI" },
  { code: "DR-102", name: "Dr. Anjali Sharma", specialty: "Paediatrician", clinic: "Kids Care", area: "Rohini Sector 9", territory: "DL-ROHINI" },
];

export const CHEMISTS = [
  { code: "CH-001", name: "Saket Medicos", area: "Saket", territory: "DL-SOUTH" },
  { code: "CH-002", name: "Verma Medical Store", area: "Lajpat Nagar", territory: "DL-SOUTH" },
  { code: "CH-003", name: "New Life Pharmacy", area: "Kalkaji", territory: "DL-SOUTH" },
  { code: "CH-101", name: "Rohini Medical Hall", area: "Rohini Sector 7", territory: "DL-ROHINI" },
] as const;

export interface SeedProduct {
  code: string;
  brandName: string;
  composition: string;
  baseUnit: string;
  units: { unit: string; toBase: number }[]; // conversions beyond the base unit
}

export const PRODUCTS: SeedProduct[] = [
  { code: "PRD-ZEN40", brandName: "Zentapra-40", composition: "Pantoprazole 40 mg", baseUnit: "strip", units: [{ unit: "box", toBase: 10 }] },
  { code: "PRD-GLYM2", brandName: "Glyconix-M2", composition: "Glimepiride 2 mg + Metformin 500 mg SR", baseUnit: "strip", units: [{ unit: "box", toBase: 10 }] },
  { code: "PRD-TEL40", brandName: "Telmora-40", composition: "Telmisartan 40 mg", baseUnit: "strip", units: [{ unit: "box", toBase: 10 }] },
  { code: "PRD-TELH", brandName: "Telmora-H", composition: "Telmisartan 40 mg + Hydrochlorothiazide 12.5 mg", baseUnit: "strip", units: [{ unit: "box", toBase: 10 }] },
  { code: "PRD-OSTD3", brandName: "Ostiva-D3", composition: "Cholecalciferol 60,000 IU", baseUnit: "sachet", units: [] },
  { code: "PRD-COUGH", brandName: "Coughzen Syrup", composition: "Dextromethorphan + Chlorpheniramine syrup", baseUnit: "bottle", units: [] },
  { code: "PRD-FERXT", brandName: "Ferovia-XT", composition: "Ferrous Ascorbate 100 mg + Folic Acid 1.5 mg", baseUnit: "strip", units: [] },
  { code: "PRD-MONLC", brandName: "Montiva-LC", composition: "Montelukast 10 mg + Levocetirizine 5 mg", baseUnit: "strip", units: [{ unit: "box", toBase: 10 }] },
  { code: "PRD-CALZ", brandName: "Calzora", composition: "Calcium Carbonate 500 mg + Vitamin D3", baseUnit: "strip", units: [{ unit: "box", toBase: 10 }] },
];

// Opening sample stock per MR, in each product's base unit. Seeded as
// admin `sample_received` events (source: opening_stock), so stock is always
// SUM(stockDelta) with no special cases.
export const OPENING_STOCK: Record<string, Record<string, number>> = {
  "MR-ROHIT": {
    "PRD-ZEN40": 40,
    "PRD-GLYM2": 30,
    "PRD-TEL40": 30,
    "PRD-TELH": 20,
    "PRD-OSTD3": 24,
    "PRD-COUGH": 6,
    "PRD-FERXT": 20,
    "PRD-MONLC": 20,
    "PRD-CALZ": 20,
  },
  "MR-PRIYA": {
    "PRD-ZEN40": 30,
    "PRD-GLYM2": 20,
    "PRD-TEL40": 20,
    "PRD-TELH": 10,
    "PRD-OSTD3": 12,
    "PRD-COUGH": 6,
    "PRD-FERXT": 20,
    "PRD-MONLC": 20,
    "PRD-CALZ": 10,
  },
};

// Date the opening stock is recorded (IST midnight start of the demo month).
export const OPENING_STOCK_AT = "2026-11-01T00:00:00+05:30";

// ── Datasets ────────────────────────────────────────────────────────────────
// A dataset = one company's master data + opening stock. DELHI (above) is the
// eval / test fixture and must stay stable so scores stay comparable;
// VARANASI (prisma/demo-data.ts) is the live-demo world.

export interface SeedDataset {
  company: { code: string; name: string };
  territories: readonly { code: string; name: string }[];
  users: SeedUser[];
  doctors: SeedDoctor[];
  chemists: readonly { code: string; name: string; area: string; territory: string }[];
  products: SeedProduct[];
  openingStock: Record<string, Record<string, number>>;
  openingStockAt: string;
}

export const DELHI: SeedDataset = {
  company: COMPANY,
  territories: TERRITORIES,
  users: USERS,
  doctors: DOCTORS,
  chemists: CHEMISTS,
  products: PRODUCTS,
  openingStock: OPENING_STOCK,
  openingStockAt: OPENING_STOCK_AT,
};
