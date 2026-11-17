import type { SeedDataset } from "./seed-data";

// Varanasi demo world. People, clinics, chemists and BRANDS are fictional:
// realistic local names and areas, invented brand names (checked only for
// being pronounceable in a Hinglish sentence, not trademark-searched).
//
// The same traps as the eval fixture, so the demo can show them:
// - Two Dr. Singhs and two Dr. Agrawals in Amit's territory (ambiguous surnames)
// - Dr. Sunil Tiwari is in Cantt (Saurabh's territory): "Tiwari sir" for Amit
//   must resolve to Dr. Rajesh Tiwari, never the Cantt one
// - Dr. Manoj Upadhyay exists; a demo note can add a NEW Dr. Rekha Upadhyay
// - Glimora-M1 vs Glimora-M2 (brand family); "Telma" (real competitor) is not ours
// - Tiwari Medical Store (chemist) vs Dr. Rajesh Tiwari (doctor)
// - Kofrex Syrup has 8 bottles in stock: "10 bottle diye" -> stock card

export const VARANASI: SeedDataset = {
  company: { code: "DEMO-VNS", name: "Kashi Pharma Demo" },
  territories: [
    { code: "VNS-SOUTH", name: "Varanasi South HQ" },
    { code: "VNS-CANTT", name: "Varanasi Cantt HQ" },
  ],
  users: [
    { code: "RBM-EAST", name: "Rajeev Srivastava", role: "RBM", territory: null, manager: null },
    { code: "ABM-VNS", name: "Alok Mishra", role: "ABM", territory: null, manager: "RBM-EAST" },
    { code: "MR-AMIT", name: "Amit Pandey", role: "MR", territory: "VNS-SOUTH", manager: "ABM-VNS" },
    { code: "MR-SAURABH", name: "Saurabh Yadav", role: "MR", territory: "VNS-CANTT", manager: "ABM-VNS" },
    { code: "ADMIN-OPS", name: "Ops Admin", role: "ADMIN", territory: null, manager: null },
  ],
  doctors: [
    // Varanasi South (MR Amit Pandey)
    { code: "VD-01", name: "Dr. Rajesh Tiwari", specialty: "General Physician", clinic: "Tiwari Clinic", area: "Lanka", territory: "VNS-SOUTH" },
    { code: "VD-02", name: "Dr. Arvind Singh", specialty: "Cardiologist", clinic: "Heart Point", area: "Sigra", territory: "VNS-SOUTH" },
    { code: "VD-03", name: "Dr. Neelam Singh", specialty: "Gynaecologist", clinic: "Singh Maternity Centre", area: "Mahmoorganj", territory: "VNS-SOUTH" },
    { code: "VD-04", name: "Dr. Pankaj Agrawal", specialty: "Diabetologist", clinic: "Sugar Care Clinic", area: "Bhelupur", territory: "VNS-SOUTH" },
    { code: "VD-05", name: "Dr. Shalini Agrawal", specialty: "Paediatrician", clinic: "Agrawal Child Care", area: "Assi", territory: "VNS-SOUTH" },
    { code: "VD-06", name: "Dr. Vinod Chaurasia", specialty: "ENT Specialist", clinic: "Kashi ENT Centre", area: "Godowlia", territory: "VNS-SOUTH" },
    { code: "VD-07", name: "Dr. Farah Siddiqui", specialty: "Dermatologist", clinic: "Skin & Glow Clinic", area: "Sigra", territory: "VNS-SOUTH" },
    { code: "VD-08", name: "Dr. Manoj Upadhyay", specialty: "Orthopaedic Surgeon", clinic: "Upadhyay Bone & Joint", area: "Mahmoorganj", territory: "VNS-SOUTH" },
    { code: "VD-09", name: "Dr. Kavita Dubey", specialty: "Gynaecologist", clinic: "Dubey Nursing Home", area: "Lanka", territory: "VNS-SOUTH" },
    { code: "VD-10", name: "Dr. Ashok Maurya", specialty: "General Physician", clinic: "Maurya Clinic", area: "Bhelupur", territory: "VNS-SOUTH" },
    { code: "VD-11", name: "Dr. Ritu Jaiswal", specialty: "Consultant Physician", clinic: "Jaiswal Hospital", area: "Sigra", territory: "VNS-SOUTH" },
    { code: "VD-12", name: "Dr. Imran Ansari", specialty: "Paediatrician", clinic: "Ansari Children Clinic", area: "Madanpura", territory: "VNS-SOUTH" },
    { code: "VD-13", name: "Dr. S. N. Shukla", specialty: "Senior Physician", clinic: "Shukla Clinic", area: "Assi", territory: "VNS-SOUTH" },
    { code: "VD-14", name: "Dr. Prakash Rai", specialty: "Diabetologist", clinic: "Rai Diabetes Centre", area: "Lanka", territory: "VNS-SOUTH" },
    { code: "VD-15", name: "Dr. Anand Kesarwani", specialty: "Chest Physician", clinic: "Kesarwani Chest Clinic", area: "Godowlia", territory: "VNS-SOUTH" },
    // Varanasi Cantt (MR Saurabh Yadav) — must never appear in Amit's shortlist
    { code: "VD-51", name: "Dr. Sunil Tiwari", specialty: "General Physician", clinic: "Cantt Family Clinic", area: "Cantt", territory: "VNS-CANTT" },
    { code: "VD-52", name: "Dr. Meera Saxena", specialty: "Gynaecologist", clinic: "Saxena Hospital", area: "Pandeypur", territory: "VNS-CANTT" },
    { code: "VD-53", name: "Dr. Rakesh Verma", specialty: "Cardiologist", clinic: "Sarnath Heart Clinic", area: "Sarnath", territory: "VNS-CANTT" },
  ],
  chemists: [
    { code: "VC-01", name: "Kashi Medical Hall", area: "Godowlia", territory: "VNS-SOUTH" },
    { code: "VC-02", name: "Tiwari Medical Store", area: "Lanka", territory: "VNS-SOUTH" },
    { code: "VC-03", name: "Sigra Pharma", area: "Sigra", territory: "VNS-SOUTH" },
    { code: "VC-04", name: "Maa Durga Medicos", area: "Bhelupur", territory: "VNS-SOUTH" },
    { code: "VC-51", name: "Cantt Medicos", area: "Cantt", territory: "VNS-CANTT" },
  ],
  products: [
    { code: "VP-GAS40", brandName: "Gastrova-40", composition: "Pantoprazole 40 mg", baseUnit: "strip", units: [{ unit: "box", toBase: 10 }] },
    { code: "VP-GLM1", brandName: "Glimora-M1", composition: "Glimepiride 1 mg + Metformin 500 mg SR", baseUnit: "strip", units: [{ unit: "box", toBase: 10 }] },
    { code: "VP-GLM2", brandName: "Glimora-M2", composition: "Glimepiride 2 mg + Metformin 500 mg SR", baseUnit: "strip", units: [{ unit: "box", toBase: 10 }] },
    { code: "VP-TEL40", brandName: "Telvika-40", composition: "Telmisartan 40 mg", baseUnit: "strip", units: [{ unit: "box", toBase: 10 }] },
    { code: "VP-AML5", brandName: "Amlovita-5", composition: "Amlodipine 5 mg", baseUnit: "strip", units: [{ unit: "box", toBase: 10 }] },
    { code: "VP-KOF", brandName: "Kofrex Syrup", composition: "Dextromethorphan + Chlorpheniramine syrup", baseUnit: "bottle", units: [] },
    { code: "VP-FERXT", brandName: "Ferrolin-XT", composition: "Ferrous Ascorbate 100 mg + Folic Acid 1.5 mg", baseUnit: "strip", units: [] },
    { code: "VP-VITD3", brandName: "Vitasol-D3", composition: "Cholecalciferol 60,000 IU", baseUnit: "sachet", units: [] },
    { code: "VP-CALN", brandName: "Calnova", composition: "Calcium Carbonate 500 mg + Vitamin D3", baseUnit: "strip", units: [{ unit: "box", toBase: 10 }] },
    { code: "VP-ALFM", brandName: "Allerfix-M", composition: "Montelukast 10 mg + Levocetirizine 5 mg", baseUnit: "strip", units: [{ unit: "box", toBase: 10 }] },
  ],
  openingStock: {
    "MR-AMIT": {
      "VP-GAS40": 40,
      "VP-GLM1": 20,
      "VP-GLM2": 30,
      "VP-TEL40": 30,
      "VP-AML5": 20,
      "VP-KOF": 8,
      "VP-FERXT": 20,
      "VP-VITD3": 24,
      "VP-CALN": 20,
      "VP-ALFM": 20,
    },
    "MR-SAURABH": {
      "VP-GAS40": 30,
      "VP-GLM1": 10,
      "VP-GLM2": 20,
      "VP-TEL40": 20,
      "VP-AML5": 10,
      "VP-KOF": 6,
      "VP-FERXT": 10,
      "VP-VITD3": 12,
      "VP-CALN": 10,
      "VP-ALFM": 10,
    },
  },
  openingStockAt: "2026-11-01T00:00:00+05:30",
};
