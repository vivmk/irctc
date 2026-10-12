import { afterEach, describe, expect, it } from "vitest";
import { clockIsOverridden, clockNow, setClock } from "../src/clock";

afterEach(() => setClock(null));

describe("clock", () => {
  it("shows real time when nothing is overridden", () => {
    const before = Date.now();
    const now = clockNow();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
    expect(clockIsOverridden()).toBe(false);
  });

  it("returns the pretend time once set, and it stays put", async () => {
    setClock(Date.parse("2026-12-27T08:00:00Z"));
    expect(clockNow()).toBe(Date.parse("2026-12-27T08:00:00Z"));
    await new Promise((r) => setTimeout(r, 15));
    expect(clockNow()).toBe(Date.parse("2026-12-27T08:00:00Z"));
    expect(clockIsOverridden()).toBe(true);
  });

  it("goes back to real time when cleared", () => {
    setClock(0);
    expect(clockNow()).toBe(0); // 0 is a valid pretend time, not "unset"
    expect(clockIsOverridden()).toBe(true);
    setClock(null);
    expect(clockIsOverridden()).toBe(false);
    expect(clockNow()).toBeGreaterThan(1_700_000_000_000);
  });
});
