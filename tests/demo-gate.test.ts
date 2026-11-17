import { describe, expect, it } from "vitest";
import { gateToken, safeEqual } from "@/lib/demo-gate";

describe("demo passcode gate", () => {
  it("cookie token is a stable hash, never the passcode itself", async () => {
    const t = await gateToken("kashi-1234");
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(t).toBe(await gateToken("kashi-1234"));
    expect(t).not.toBe(await gateToken("kashi-1235"));
    expect(t).not.toContain("kashi");
  });

  it("safeEqual compares exactly", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
