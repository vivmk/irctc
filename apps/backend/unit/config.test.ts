import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEYS = [
  "PORT", "DATABASE_URL", "REDIS_URL", "HOLD_SECONDS", "SELF_URL", "BANK_SECRET", "FARE_PAISE",
  "ENABLE_FAKE_BANK", "QUEUE_PREFIX", "NOTIFY_ATTEMPTS", "CANCEL_FEE_PAISE", "SESSION_HOURS", "LOG_LEVEL",
  "LOGIN_MAX_FAILURES", "REQUEUE_AFTER_SECONDS",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } vi.resetModules(); });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const load = async () => (await import("../src/config")).config;

describe("config", () => {
  it("has sensible defaults for a laptop", async () => {
    const c = await load();
    expect(c.port).toBe(3001);
    expect(c.databaseUrl).toBe("postgres://irctc:irctc@localhost:5432/irctc");
    expect(c.redisUrl).toBe("redis://localhost:6379");
    expect(c.holdSeconds).toBe(300);
    expect(c.farePaise).toBe(50000);
    expect(c.cancelFeePaise).toBe(6000);
    expect(c.loginMaxFailures).toBe(5);
    expect(c.sessionHours).toBe(24);
    expect(c.queuePrefix).toBe("irctc");
    expect(c.logLevel).toBe("info");
  });

  it("reads numbers from the environment", async () => {
    process.env.PORT = "4000";
    process.env.HOLD_SECONDS = "3";
    process.env.NOTIFY_ATTEMPTS = "8";
    const c = await load();
    expect([c.port, c.holdSeconds, c.notifyAttempts]).toEqual([4000, 3, 8]);
    expect(typeof c.holdSeconds).toBe("number");
  });

  it("derives the bank's callback address from the port unless told otherwise", async () => {
    process.env.PORT = "3101";
    expect((await load()).selfUrl).toBe("http://localhost:3101");
    vi.resetModules();
    process.env.SELF_URL = "https://api.example.com";
    expect((await load()).selfUrl).toBe("https://api.example.com");
  });

  it("the fake bank is ON unless explicitly set to the text 'false'", async () => {
    expect((await load()).enableFakeBank).toBe(true);
    for (const [v, want] of [["false", false], ["true", true], ["0", true], ["", true]] as const) {
      vi.resetModules();
      process.env.ENABLE_FAKE_BANK = v;
      expect((await load()).enableFakeBank, `ENABLE_FAKE_BANK=${v}`).toBe(want);
    }
  });

  it("uses a different queue prefix when asked (keeps dev and test queues apart)", async () => {
    process.env.QUEUE_PREFIX = "irctc-test";
    expect((await load()).queuePrefix).toBe("irctc-test");
  });
});
