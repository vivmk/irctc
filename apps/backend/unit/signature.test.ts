import { describe, expect, it } from "vitest";
import { sign, verify } from "../src/signature";

describe("sign", () => {
  it("is deterministic and looks like a sha256 hex digest", () => {
    const a = sign("ref-1", "paid", 50000);
    expect(a).toBe(sign("ref-1", "paid", 50000));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when ANY of reference, status or amount changes", () => {
    const base = sign("ref-1", "paid", 50000);
    expect(sign("ref-2", "paid", 50000)).not.toBe(base);
    expect(sign("ref-1", "failed", 50000)).not.toBe(base);
    expect(sign("ref-1", "paid", 50001)).not.toBe(base);
  });

  it("can't be confused by moving the separator between fields", () => {
    expect(sign("a|b", "paid", 1)).not.toBe(sign("a", "b|paid", 1));
  });
});

describe("verify", () => {
  it("accepts the genuine signature", () => {
    expect(verify("ref-1", "paid", 50000, sign("ref-1", "paid", 50000))).toBe(true);
  });

  it("rejects a signature made for different data", () => {
    const s = sign("ref-1", "paid", 50000);
    expect(verify("ref-1", "paid", 1, s)).toBe(false);
    expect(verify("ref-1", "failed", 50000, s)).toBe(false);
    expect(verify("ref-9", "paid", 50000, s)).toBe(false);
  });

  it("rejects garbage of any length without throwing", () => {
    for (const bad of ["", "abc", "x".repeat(64), "f".repeat(10_000), "not-a-real-signature"]) {
      expect(verify("ref-1", "paid", 50000, bad)).toBe(false);
    }
  });

  it("rejects a signature that differs in a single character", () => {
    const s = sign("ref-1", "paid", 50000);
    const flipped = (s[0] === "a" ? "b" : "a") + s.slice(1);
    expect(verify("ref-1", "paid", 50000, flipped)).toBe(false);
  });
});
