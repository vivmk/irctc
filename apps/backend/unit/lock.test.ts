import { beforeEach, describe, expect, it, vi } from "vitest";

const { redis } = vi.hoisted(() => ({
  redis: { status: "ready", connect: vi.fn(), set: vi.fn(), eval: vi.fn() },
}));
vi.mock("../src/redis", () => ({ redis }));

import { withLock } from "../src/lock";

beforeEach(() => {
  redis.status = "ready";
  redis.connect.mockResolvedValue(undefined);
  redis.set.mockResolvedValue("OK");
  redis.eval.mockResolvedValue(1);
});

describe("withLock", () => {
  it("takes the lock with set-if-absent and an expiry, runs the job, then releases", async () => {
    const job = vi.fn(async () => {});
    expect(await withLock("sweep", 25_000, job)).toBe(true);
    const [key, token, px, ttl, nx] = redis.set.mock.calls[0];
    expect(key).toBe("irctc:lock:sweep");
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect([px, ttl, nx]).toEqual(["PX", 25_000, "NX"]);
    expect(job).toHaveBeenCalledOnce();
    expect(redis.eval).toHaveBeenCalledOnce();
  });

  it("releases only if the lock is still OURS: passes our own token to the release script", async () => {
    await withLock("x", 1000, async () => {});
    const [script, nKeys, key, token] = redis.eval.mock.calls[0];
    expect(script).toContain('redis.call("get", KEYS[1]) == ARGV[1]');
    expect(nKeys).toBe(1);
    expect(key).toBe("irctc:lock:x");
    expect(token).toBe(redis.set.mock.calls[0][1]);
  });

  it("does NOT run the job when someone else holds the lock", async () => {
    redis.set.mockResolvedValue(null);
    const job = vi.fn();
    expect(await withLock("sweep", 1000, job)).toBe(false);
    expect(job).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled(); // never release someone else's lock
  });

  it("still releases the lock when the job throws, and passes the error on", async () => {
    await expect(withLock("x", 1000, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(redis.eval).toHaveBeenCalledOnce();
  });

  it("a failing release doesn't turn a successful job into a failure", async () => {
    redis.eval.mockRejectedValue(new Error("redis gone"));
    expect(await withLock("x", 1000, async () => {})).toBe(true);
  });

  it("connects first if the Redis client hasn't connected yet", async () => {
    redis.status = "wait";
    await withLock("x", 1000, async () => {});
    expect(redis.connect).toHaveBeenCalledOnce();
  });

  it("each call uses a fresh token, so two runners can't release each other's lock", async () => {
    await withLock("x", 1000, async () => {});
    await withLock("x", 1000, async () => {});
    expect(redis.set.mock.calls[0][1]).not.toBe(redis.set.mock.calls[1][1]);
  });

  it("if Redis itself fails, the error surfaces (the scheduler logs it) and the job doesn't run", async () => {
    redis.set.mockRejectedValue(new Error("Redis down"));
    const job = vi.fn();
    await expect(withLock("x", 1000, job)).rejects.toThrow("Redis down");
    expect(job).not.toHaveBeenCalled();
  });
});
