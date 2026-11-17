import { describe, expect, it, vi } from "vitest";
import { audioExtension, baseMime, segmentKey } from "@/lib/audio";
import { contextFromSeed } from "@/lib/context";
import { keytermsFor } from "@/lib/keyterms";
import { buildSttForm, cleanKeyterms, MAX_KEYTERMS, SarvamError, transcribe } from "@/lib/sarvam";
import { VARANASI } from "@/prisma/demo-data";

describe("audio formats from phone browsers", () => {
  it.each([
    ["audio/webm;codecs=opus", "webm"], // Android Chrome
    ["audio/mp4", "m4a"], // iOS Safari
    ["audio/mp4;codecs=mp4a.40.2", "m4a"],
    ["audio/ogg;codecs=opus", "ogg"],
    ["audio/wav", "wav"],
  ])("%s -> .%s", (mime, ext) => {
    expect(audioExtension(mime)).toBe(ext);
  });

  it("strips codec parameters (Sarvam matches the Content-Type exactly)", () => {
    expect(baseMime("audio/webm;codecs=opus")).toBe("audio/webm");
  });

  it("segment keys are stable per message id, so a retried upload overwrites", () => {
    expect(segmentKey("abc-123", 1, "audio/mp4")).toBe("audio/abc-123/01.m4a");
    expect(segmentKey("abc-123", 1, "audio/mp4")).toBe(segmentKey("abc-123", 1, "audio/mp4;codecs=mp4a.40.2"));
  });
});

describe("Sarvam request", () => {
  it("uses saaras:v4 + codemix + JSON keyterms, file typed without codecs", async () => {
    const form = buildSttForm(new Uint8Array([1, 2, 3]), "audio/webm;codecs=opus", ["Gastrova", "Telvika"]);
    expect(form.get("model")).toBe("saaras:v4");
    expect(form.get("mode")).toBe("codemix");
    expect(form.get("language_code")).toBe("unknown");
    expect(JSON.parse(String(form.get("keyterms")))).toEqual(["Gastrova", "Telvika"]);
    const file = form.get("file") as File;
    expect(file.type).toBe("audio/webm");
    expect(file.name).toBe("segment.webm");
  });

  it("keyterms: deduped (case-insensitive), ≤64 chars, at most 50", () => {
    const many = Array.from({ length: 80 }, (_, i) => `Term${i}`);
    expect(cleanKeyterms([...many, "x".repeat(65)])).toHaveLength(MAX_KEYTERMS);
    expect(cleanKeyterms(["Gastrova", "gastrova ", "", "x".repeat(65)])).toEqual(["Gastrova"]);
  });

  it("maps a non-2xx answer to SarvamError and returns the transcript on success", async () => {
    vi.stubEnv("SARVAM_API_KEY", "test-key");
    const bad = vi.fn().mockResolvedValue(new Response("nope", { status: 403 }));
    await expect(transcribe(new Uint8Array([1]), "audio/mp4", [], bad as unknown as typeof fetch)).rejects.toBeInstanceOf(SarvamError);
    const ok = vi.fn().mockResolvedValue(new Response(JSON.stringify({ transcript: " Tiwari sir ko Gastrova ", language_code: "hi-IN" })));
    const r = await transcribe(new Uint8Array([1]), "audio/mp4", ["Gastrova"], ok as unknown as typeof fetch);
    expect(r).toEqual({ transcript: "Tiwari sir ko Gastrova", languageCode: "hi-IN", model: "saaras:v4" });
    expect((ok.mock.calls[0][1] as RequestInit).headers).toEqual({ "api-subscription-key": "test-key" });
    vi.unstubAllEnvs();
  });
});

describe("keyterms for an MR (speech-to-text vocabulary)", () => {
  const terms = keytermsFor(contextFromSeed("MR-AMIT", VARANASI));

  it("fits Sarvam's limit and leads with our brand names", () => {
    expect(terms.length).toBeLessThanOrEqual(MAX_KEYTERMS);
    expect(terms.slice(0, 10)).toEqual(
      expect.arrayContaining(["Gastrova", "Glimora", "Telvika", "Amlovita", "Kofrex", "Ferrolin", "Vitasol", "Calnova", "Allerfix"])
    );
  });

  it("includes this MR's doctor surnames and spoken brand variants, not other territories", () => {
    expect(terms).toEqual(expect.arrayContaining(["Tiwari", "Siddiqui", "Upadhyay", "Glimora M2", "Telvika 40"]));
    expect(terms).not.toContain("Saxena"); // Cantt doctor (other MR)
    expect(terms.filter((t) => t === "Tiwari")).toHaveLength(1);
  });
});
